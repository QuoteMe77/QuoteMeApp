"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveQuote, deleteQuoteAndRedirect, type QuoteItemInput, type QuoteMetaInput } from "@/app/dashboard/quotes/actions";
import { createClient as createBrowserClient } from "@/lib/supabase/client";
import { downloadQuotePdf } from "@/lib/exportPdf";
import { downloadQuoteDocx } from "@/lib/exportDocx";
import { PDFDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import { normaliseFigure, findDimensionStrings } from "@/lib/dimensionRows";
import { analyseElevations, dropNonFrontViews, findDrawerView } from "@/lib/elevationBands";
import type { DrawerView } from "@/lib/elevationBands";
import type { DimensionString, TextWord } from "@/lib/dimensionRows";

// Above this size, a PDF is routed through the page-picker instead of being
// uploaded whole — a full multi-trade construction document set can run to
// 60-100MB, well past both Supabase Storage's 50MB free-plan ceiling and
// Claude's own 32MB-per-PDF limit, and almost always contains far more than
// the joinery-relevant sheets anyway.
const PAGES_PER_READ = 5; // pages sent to the AI per request when reading a big set
const PDF_PICKER_THRESHOLD_BYTES = 8 * 1024 * 1024;
const UPLOAD_HARD_LIMIT_BYTES = 45 * 1024 * 1024; // stay under Supabase's 50MB cap with headroom
// The Anthropic API itself caps a single request body at ~32MB. We send
// files base64-encoded inside one JSON request, which inflates raw bytes by
// roughly 4/3 — so the combined plan + schedule size needs checking against
// this before upload, independently of Supabase's much larger ceiling.
const ANTHROPIC_REQUEST_LIMIT_BYTES = 32 * 1024 * 1024;
const PDFJS_VERSION = "3.11.174";

function estimateBase64Size(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

let pdfjsWorkerConfigured = false;
function ensurePdfjsWorker() {
  if (pdfjsWorkerConfigured) return;
  // Loaded from jsDelivr rather than bundled: pinning an exact version here
  // guarantees the worker file matches the installed pdfjs-dist version
  // without pulling Next.js's webpack config into web-worker bundling.
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.js`;
  pdfjsWorkerConfigured = true;
}

function allPageIndices(pageCount: number): Set<number> {
  return new Set(Array.from({ length: pageCount }, (_, i) => i));
}

function parsePageSpec(spec: string, pageCount: number): number[] {
  const trimmed = spec.trim();
  if (!trimmed) return Array.from({ length: pageCount }, (_, i) => i);
  const indices = new Set<number>();
  for (const part of trimmed.split(",")) {
    const token = part.trim();
    if (!token) continue;
    const rangeMatch = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      for (let n = Math.min(start, end); n <= Math.max(start, end); n++) {
        if (n >= 1 && n <= pageCount) indices.add(n - 1);
      }
    } else if (/^\d+$/.test(token)) {
      const n = parseInt(token, 10);
      if (n >= 1 && n <= pageCount) indices.add(n - 1);
    }
  }
  return Array.from(indices).sort((a, b) => a - b);
}

// Turns a selected set of (0-indexed) pages back into a compact "4, 7, 12-14"
// string, so the text field stays in sync after the user clicks thumbnails.
function serializePageSpec(indices: Set<number>, pageCount: number): string {
  if (indices.size === 0 || indices.size === pageCount) return "";
  const sorted = Array.from(indices).sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    parts.push(start === prev ? `${start + 1}` : `${start + 1}-${prev + 1}`);
    if (cur === undefined) break;
    start = cur;
    prev = cur;
  }
  return parts.join(", ");
}

async function extractPdfPages(file: File, indices: number[]): Promise<File> {
  const srcBytes = await file.arrayBuffer();
  const srcDoc = await PDFDocument.load(srcBytes);
  const newDoc = await PDFDocument.create();
  const copiedPages = await newDoc.copyPages(srcDoc, indices);
  copiedPages.forEach((p) => newDoc.addPage(p));
  const newBytes = await newDoc.save();
  const baseName = file.name.replace(/\.pdf$/i, "");
  return new File([newBytes as BlobPart], `${baseName}-selected.pdf`, { type: "application/pdf" });
}

// Renders a low-res JPEG thumbnail of every page so the user can see what
// they're picking instead of guessing from page numbers alone. Thumbnails
// are reported back one at a time via onPage so the grid fills in
// progressively on a 50-100 page document instead of showing nothing for a
// long time.
async function renderPdfThumbnails(file: File, onPage: (index: number, dataUrl: string) => void): Promise<void> {
  ensurePdfjsWorker();
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 0.3 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      await page.render({ canvasContext: ctx, viewport }).promise;
      onPage(i - 1, canvas.toDataURL("image/jpeg", 0.5));
    }
    page.cleanup();
  }
}

// Re-renders one page of the plan (PDF or a plain image upload) and draws a
// highlight box at the AI-reported fractional bbox, so the estimator can see
// exactly what the model was looking at rather than just trusting the
// number it produced. This is a visual aid, not a verified measurement —
// the model's own best guess at where it read something, nothing more.
async function renderPlanRegionPreview(
  file: File,
  page: number,
  bbox: [number, number, number, number]
): Promise<string> {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const canvas = document.createElement("canvas");
  let ctx: CanvasRenderingContext2D | null;

  if (isPdf) {
    ensurePdfjsWorker();
    const data = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const pageIndex = Math.min(Math.max(page, 1), pdf.numPages);
    const pdfPage = await pdf.getPage(pageIndex);
    const baseViewport = pdfPage.getViewport({ scale: 1 });
    const scale = Math.min(2.5, 1600 / baseViewport.width);
    const viewport = pdfPage.getViewport({ scale });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    ctx = canvas.getContext("2d");
    if (ctx) await pdfPage.render({ canvasContext: ctx, viewport }).promise;
    pdfPage.cleanup();
  } else {
    const objectUrl = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = objectUrl;
      await img.decode();
      const scale = Math.min(2.5, 1600 / img.width);
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      ctx = canvas.getContext("2d");
      if (ctx) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  if (ctx) {
    const [x0, y0, x1, y1] = bbox;
    const bx = Math.max(0, Math.min(1, x0)) * canvas.width;
    const by = Math.max(0, Math.min(1, y0)) * canvas.height;
    const bw = Math.max(0, Math.min(1, x1) - Math.min(1, Math.max(0, x0))) * canvas.width;
    const bh = Math.max(0, Math.min(1, y1) - Math.min(1, Math.max(0, y0))) * canvas.height;
    ctx.save();
    ctx.fillStyle = "rgba(225, 29, 72, 0.18)";
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = "#e11d48";
    ctx.lineWidth = Math.max(2, canvas.width * 0.003);
    ctx.strokeRect(bx, by, bw, bh);
    ctx.restore();
  }

  return canvas.toDataURL("image/jpeg", 0.85);
}

// Distinct outline colours for the "View all on plan" overview, so several
// items' boxes can share one page image and still be told apart.
const OVERVIEW_COLORS = [
  "#e11d48", "#2563eb", "#16a34a", "#d97706", "#7c3aed",
  "#0891b2", "#db2777", "#65a30d", "#ea580c", "#4b5563",
];

// Finds the radius callouts ("R 300") printed beside curved ends on plan views, as page
// fractions, so a curved-end item can be boxed and counted from the drawing's own text.
async function extractRadiusMarks(file: File): Promise<Map<number, { x: number; y: number }[]>> {
  const marks = new Map<number, { x: number; y: number }[]>();
  if (!/pdf/i.test(file.type) && !/\.pdf$/i.test(file.name)) return marks;
  try {
    ensurePdfjsWorker();
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const tc = await (page as unknown as { getTextContent(): Promise<{ items: unknown[] }> }).getTextContent();
      for (const r of tc.items as unknown as { str?: string; transform: number[]; width: number }[]) {
        if (/^R\s?\d{2,4}$/.test((r.str || "").trim())) {
          const list = marks.get(i) || [];
          list.push({ x: (r.transform[4] + r.width / 2) / viewport.width, y: (viewport.height - r.transform[5]) / viewport.height });
          marks.set(i, list);
        }
      }
    }
  } catch {
    /* no marks */
  }
  return marks;
}

// Drawer counts read from the printed "DRAWER" / "INNER DRAWER" labels inside each sheet's
// ELEVATION views (never a plan view or side section, which repeat the same drawers), with
// a box around the labelled drawers for "View on plan".
async function extractDrawerViews(file: File): Promise<Map<number, DrawerView>> {
  const out = new Map<number, DrawerView>();
  if (!/pdf/i.test(file.type) && !/\.pdf$/i.test(file.name)) return out;
  try {
    ensurePdfjsWorker();
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const tc = await (page as unknown as { getTextContent(): Promise<{ items: unknown[] }> }).getTextContent();
      const words: TextWord[] = [];
      let archicad = false; // figures printed like "1,166" / "(COS)" mark this sheet style
      for (const raw of tc.items as unknown as { str?: string; transform: number[]; width: number; height: number }[]) {
        const str = (raw.str || "").trim();
        if (!str) continue;
        if (/^\d{1,2},\d{3}/.test(str) || /\(COS\)/i.test(str)) archicad = true;
        const tr = raw.transform;
        const rotated = Math.abs(tr[1]) > 0.01 && Math.abs(tr[1]) >= Math.abs(tr[0]);
        words.push({ str, x: tr[4], y: viewport.height - tr[5] - (raw.height || 0) / 2, w: raw.width, rotated });
      }
      if (!archicad) continue;
      const dv = findDrawerView(words, i, viewport.width, viewport.height);
      if (dv && dv.count > 0) out.set(i, dv);
    }
  } catch {
    /* no drawer labels */
  }
  return out;
}

// Reads each sheet's title block ("TITLE: BED 2 WARDROBE") from the PDF's own text, so a
// page can be tied to its room without trusting the AI's page numbers.
async function extractPageTitles(file: File): Promise<Map<number, string>> {
  const titles = new Map<number, string>();
  if (!/pdf/i.test(file.type) && !/\.pdf$/i.test(file.name)) return titles;
  try {
    ensurePdfjsWorker();
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const tc = await (page as unknown as { getTextContent(): Promise<{ items: unknown[] }> }).getTextContent();
      const items = (tc.items as unknown as { str?: string; transform: number[] }[])
        .map((r) => ({ s: (r.str || "").trim(), x: r.transform[4], y: viewport.height - r.transform[5], size: Math.abs(r.transform[3]) }))
        .filter((r) => r.s);
      const ti = items.find((r) => /^TITLE:?/i.test(r.s));
      let text = "";
      if (ti) {
        const inline = ti.s.replace(/^TITLE:?\s*/i, "");
        text = (inline
          ? inline
          : items
              .filter((r) => r.x >= ti.x - 4 && r.x < ti.x + 220 && r.y > ti.y + 2 && r.y < ti.y + 24)
              .sort((a, b) => a.y - b.y || a.x - b.x)
              .map((r) => r.s)
              .join(" ")
        )
          .replace(/\s+(SCALE|DRAWN BY|DRAWING NO).*$/i, "")
          .trim();
      }
      if (!text) {
        // Fallback: the sheet's title is the largest lettering in the bottom-right title block.
        const block = items.filter((r) => r.x > viewport.width * 0.78 && r.y > viewport.height * 0.85 && r.size > 0);
        const top = block.reduce((m, r) => Math.max(m, r.size), 0);
        text = block
          .filter((r) => r.size >= top - 0.2 && !/^(FOR APPROVAL|NORTH:?|TITLE:?)$/i.test(r.s))
          .sort((a, b) => a.y - b.y || a.x - b.x)
          .map((r) => r.s)
          .join(" ")
          .trim();
      }
      if (text) titles.set(i, text);
    }
  } catch {
    /* no titles — fall back to the AI's own page guesses */
  }
  return titles;
}

// Pulls the printed dimension strings (column widths) out of the PDF's own
// text layer, exactly and repeatably, so the AI never has to read tiny
// numbers off a picture. Returns [] for scans/images with no text layer, in
// which case the server falls back to the AI's own reading.
async function extractDimensionStrings(file: File): Promise<{ strings: DimensionString[]; note: string }> {
  if (!/pdf/i.test(file.type) && !/\.pdf$/i.test(file.name)) return { strings: [], note: "file is an image, not a PDF" };
  try {
    ensurePdfjsWorker();
    const data = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const out: DimensionString[] = [];
    let totalItems = 0;
    const bigNums: number[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      // Cast: the installed pdfjs typings mark getTextContent's options as required.
      const tc = await (page as unknown as { getTextContent(): Promise<{ items: unknown[] }> }).getTextContent();
      const words: TextWord[] = [];
      let sawComma = false;
      for (const raw of tc.items as unknown as { str?: string; transform: number[]; width: number; height: number }[]) {
        const rawStr = (raw.str || "").trim();
        if (/^\d{1,2},\d{3}/.test(rawStr) || /\(COS\)/i.test(rawStr)) sawComma = true;
        const str = normaliseFigure(rawStr);
        if (!str) continue;
        const tr = raw.transform;
        const e = tr[4];
        const f = tr[5];
        const rotated = Math.abs(tr[1]) > 0.01 && Math.abs(tr[1]) >= Math.abs(tr[0]);
        // Rotated text runs along the page's vertical axis: its centre is half its
        // WIDTH up/down from the baseline start; horizontal text is half its height.
        const y = rotated
          ? tr[1] > 0
            ? viewport.height - f - raw.width / 2
            : viewport.height - f + raw.width / 2
          : viewport.height - f - (raw.height || 0) / 2;
        const parts = str.split(/\s+/);
        if (parts.length > 1 && parts.every((t) => /^\d+(\.\d+)?$/.test(t))) {
          // several figures in one text run: split by character share
          const total = parts.reduce((n, t) => n + t.length + 1, -1);
          let cursor = 0;
          for (const t of parts) {
            words.push({ str: t, x: e + (raw.width * cursor) / total, y, w: (raw.width * t.length) / total, rotated });
            cursor += t.length + 1;
          }
        } else {
          words.push({ str, x: e, y, w: raw.width, rotated });
        }
      }
      totalItems += words.length;
      for (const w of words) {
        const n = /^\d+(\.\d+)?$/.test(w.str) ? parseFloat(w.str) : 0;
        if (n >= 300 && bigNums.length < 8) bigNums.push(n);
      }
      let found = findDimensionStrings(words, i, viewport.width, viewport.height, sawComma ? 12 : 1);
      if (sawComma) found = dropNonFrontViews(words, found);
      if (words.some((w) => /\bLED\d*\b/i.test(w.str))) found.forEach((d) => (d.led = true));
      if (sawComma) {
        found.forEach((d) => (d.keepEnds = true));
        // Archicad-style sheets print a height chain and labels that say exactly what each
        // elevation is made of — worked out here, no AI needed.
        analyseElevations(words, found, viewport.width, viewport.height);
      }
      out.push(...found);
    }
    // Repeated copies of an elevation (e.g. a mirrored view on another page) are all
    // kept: the server pools the AI's votes across copies and counts the wall once.
    const unique = out;
    return {
      strings: unique,
      note: unique.length
        ? `found ${unique.length} dimension string(s) in the PDF text`
        : `no dimension strings found (PDF has ${pdf.numPages} page(s), ${totalItems} text pieces; large figures seen: ${bigNums.join(", ") || "none"})`,
    };
  } catch (err) {
    console.error("Could not read dimension text from the PDF:", err);
    return { strings: [], note: `PDF text reading failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200) };
  }
}

// Renders one PDF page / image ONCE and draws every given box on it, each in
// its own colour with a numbered tag — the numbers match a legend shown under
// the image. Used by "View all on plan" so every item can be checked (and
// screenshotted) in a single view instead of opening each item one by one.
async function renderPlanOverview(
  file: File,
  page: number,
  boxes: { n: number; bbox: [number, number, number, number] }[]
): Promise<string> {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const canvas = document.createElement("canvas");
  let ctx: CanvasRenderingContext2D | null;

  if (isPdf) {
    ensurePdfjsWorker();
    const data = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const pageIndex = Math.min(Math.max(page, 1), pdf.numPages);
    const pdfPage = await pdf.getPage(pageIndex);
    const baseViewport = pdfPage.getViewport({ scale: 1 });
    const scale = Math.min(2.5, 1600 / baseViewport.width);
    const viewport = pdfPage.getViewport({ scale });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    ctx = canvas.getContext("2d");
    if (ctx) await pdfPage.render({ canvasContext: ctx, viewport }).promise;
    pdfPage.cleanup();
  } else {
    const objectUrl = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = objectUrl;
      await img.decode();
      const scale = Math.min(2.5, 1600 / img.width);
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      ctx = canvas.getContext("2d");
      if (ctx) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  if (ctx) {
    const fontPx = Math.max(14, Math.round(canvas.width * 0.014));
    ctx.font = `bold ${fontPx}px sans-serif`;
    ctx.textBaseline = "middle";
    for (const { n, bbox } of boxes) {
      const color = OVERVIEW_COLORS[(n - 1) % OVERVIEW_COLORS.length];
      const [x0, y0, x1, y1] = bbox;
      const bx = Math.max(0, Math.min(1, x0)) * canvas.width;
      const by = Math.max(0, Math.min(1, y0)) * canvas.height;
      const bw = Math.max(0, Math.min(1, x1) - Math.min(1, Math.max(0, x0))) * canvas.width;
      const bh = Math.max(0, Math.min(1, y1) - Math.min(1, Math.max(0, y0))) * canvas.height;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(2, canvas.width * 0.003);
      ctx.strokeRect(bx, by, bw, bh);
      // Numbered tag in the box's top-left corner.
      const label = String(n);
      const tagW = ctx.measureText(label).width + fontPx * 0.8;
      const tagH = fontPx * 1.4;
      ctx.fillStyle = color;
      ctx.fillRect(bx, by, tagW, tagH);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, bx + fontPx * 0.4, by + tagH / 2);
      ctx.restore();
    }
  }

  return canvas.toDataURL("image/jpeg", 0.85);
}

type Calc = "LM" | "QTY" | "MISC";

// One elevation's column inventory as transcribed by the AI (printed widths +
// what kind of cabinetry each column is), plus what the application worked
// out from it. The AI only copies figures; all adding-up happens in code.
type ColumnGeom = {
  page: number;
  frame?: { top: number; bottom: number; mm: number };
  cols: { x0: number; x1: number }[];
  // Bands read from the drawing's own height chain (see lib/elevationBands.ts).
  det?: { floor: number; k: number; bands: { kind: "base" | "wall" | "tall"; lo: number; hi: number }[]; printed?: { wall?: number } };
  led?: boolean;
};
type ColumnReport = {
  geom?: ColumnGeom;
  name: string;
  room: string;
  page: number;
  overall: number;
  sum: number;
  ok: boolean;
  columns: { width_mm: number; kind: string; label: string }[];
  base: number;
  wall: number;
  tall: number;
};

type PriceBookItem = {
  id: string;
  calc: Calc;
  section: string;
  category: string;
  name: string;
  rate: number;
  unit: string;
  sort_order: number;
};

type QuoteRow = {
  id: string;
  quote_ref: string | null;
  client_name: string | null;
  job_address: string | null;
  quote_date: string | null;
  valid_days: number | null;
  markup_pct: number | null;
  notes: string | null;
} | null;

type QuoteItemRow = {
  id: string;
  price_book_item_id: string | null;
  name: string;
  category: string | null;
  calc: Calc;
  unit: string | null;
  rate: number;
  qty: number;
  area: string | null;
  note: string | null;
  pdf_label: string | null;
  poa: boolean;
  flag_label: string | null;
};

type LineItem = {
  key: string; // client-side identity, stable across re-renders
  price_book_item_id: string | null;
  name: string;
  category: string;
  calc: Calc;
  unit: string;
  rate: number;
  qty: number;
  area: string;
  note: string;
  pdf_label: string;
  poa: boolean;
  flag_label: string;
};

function money(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

let keySeq = 0;
function newKey() {
  keySeq += 1;
  return `new-${Date.now()}-${keySeq}`;
}

export default function QuoteBuilder({
  priceBook,
  quote,
  items,
  defaultBusinessName,
  defaultBusinessContact,
  defaultBuilderName,
}: {
  priceBook: PriceBookItem[];
  quote: QuoteRow;
  items: QuoteItemRow[];
  defaultBusinessName: string;
  defaultBusinessContact: string;
  defaultBuilderName: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  const [businessName] = useState(defaultBusinessName);
  const [businessContact] = useState(defaultBusinessContact);
  const [builderName, setBuilderName] = useState(defaultBuilderName);
  const [clientName, setClientName] = useState(quote?.client_name || "");
  const [jobAddress, setJobAddress] = useState(quote?.job_address || "");
  const [quoteRef, setQuoteRef] = useState(quote?.quote_ref || "");
  const [quoteDate, setQuoteDate] = useState(
    quote?.quote_date || new Date().toISOString().slice(0, 10)
  );
  const [validDays, setValidDays] = useState(quote?.valid_days ?? 30);
  const [markupPct, setMarkupPct] = useState(quote?.markup_pct ?? 32);
  const [notes, setNotes] = useState(quote?.notes || "");

  const [lineItems, setLineItems] = useState<LineItem[]>(() =>
    items.map((it) => ({
      key: it.id,
      price_book_item_id: it.price_book_item_id,
      name: it.name,
      category: it.category || "",
      calc: it.calc,
      unit: it.unit || "",
      rate: Number(it.rate),
      qty: Number(it.qty),
      area: it.area || "General",
      note: it.note || "",
      pdf_label: it.pdf_label || "",
      poa: it.poa,
      flag_label: it.flag_label || "",
    }))
  );

  const [search, setSearch] = useState("");
  const [activeArea, setActiveArea] = useState("General");

  type PlanItemResult = {
    room: string;
    name: string;
    cabinet_type: "base" | "wall" | "tall" | "other";
    open: boolean;
    calc: Calc;
    qty: number;
    unit: string;
    material_hint: string;
    drawer_count: number;
    pto_drawer_count: number;
    drawer_brand: string;
    note: string;
    confidence: string;
    // Set by mergePlanBands, not the model — a deterministic, code-level
    // check (not something we can trust the AI to police in itself) for the
    // specific failure mode that kept recurring: the same physical wall
    // reported more than once under different wording, which silently
    // double-counts its length once summed. Undefined when nothing looked
    // suspicious.
    duplicate_wall_warning?: string;
    // Where on the plan the model says it read this item from — one entry
    // per page it's drawn on, each a fractional (0-1) bounding box of that
    // page. Used only to let the estimator visually sanity-check a read
    // against the actual drawing; not guaranteed pixel-accurate.
    regions?: { page: number; bbox: [number, number, number, number] }[];
  };

  const [planUploading, setPlanUploading] = useState(false);
  const [planProgress, setPlanProgress] = useState("");
  const [expandedPlanItems, setExpandedPlanItems] = useState<Set<number>>(new Set());
  const [removedPlanItems, setRemovedPlanItems] = useState<Set<number>>(new Set());
  const [planError, setPlanError] = useState<string | null>(null);
  const [planResult, setPlanResult] = useState<{
    items: PlanItemResult[];
    flags: string[];
    consistency_warnings?: string[];
    room_label_warning?: string;
    column_report?: ColumnReport[];
    column_warnings?: string[];
    column_source?: string;
    dim_note?: string;
    column_base?: { items: PlanItemResult[] };
  } | null>(null);
  const [selectedPlanItems, setSelectedPlanItems] = useState<Set<number>>(new Set());
  // index -> chosen price_book_items.id for base/wall/tall items awaiting a material pick
  const [planItemMaterial, setPlanItemMaterial] = useState<Record<number, string>>({});
  // index -> note explaining the match (or lack of one) for that item, shown to the estimator
  const [planItemFlag, setPlanItemFlag] = useState<Record<number, string>>({});
  const [scheduleFileName, setScheduleFileName] = useState<string | null>(null);
  // The plan file itself, kept purely so "View on plan" (below) can
  // re-render a page on demand and draw the AI's reported region on it.
  const [lastPlanFile, setLastPlanFile] = useState<File | null>(null);
  const [regionPreview, setRegionPreview] = useState<{
    itemName: string;
    regions: { page: number; bbox: [number, number, number, number] }[];
    index: number;
    imageUrl: string | null;
    loading: boolean;
    error: string | null;
    suspect: boolean;
  } | null>(null);
  // "View all on plan": every item's box drawn together, one image per page,
  // with a numbered legend — one click instead of opening items one by one.
  const [overview, setOverview] = useState<{
    loading: boolean;
    error: string | null;
    pages: { page: number; imageUrl: string | null; error: string | null }[];
    legend: { n: number; name: string; qty: string; page: number; suspect: boolean }[];
    noRegions: string[]; // items that came back with no box at all
  } | null>(null);
  const scheduleFileRef = useRef<File | null>(null);

  function categoryPrefixFor(cabinetType: string): string | null {
    if (cabinetType === "base") return "Base cabinets";
    if (cabinetType === "wall") return "Wall cabinets";
    if (cabinetType === "tall") return "Tall cabinets";
    return null;
  }

  // Cabinet runs (base/wall/tall) are priced from a fixed LM category band;
  // everything else — end panels, laundry chutes/hampers, LED strips,
  // hardware call-outs, and any other discrete joinery scope — doesn't live
  // in one predictable category, so it's matched by keyword relevance
  // against the whole price book instead (excluding drawer-brand hardware,
  // which is matched separately via drawer_count/drawer_brand).
  function materialOptionsFor(it: PlanItemResult): PriceBookItem[] {
    if (isNoPriceScopeItem(it)) return [];
    const prefix = categoryPrefixFor(it.cabinet_type);
    if (prefix) {
      return priceBook.filter(
        (p) => p.calc === "LM" && p.category.startsWith(prefix) && /open/i.test(p.name) === it.open
      );
    }

    const keywords = materialKeywords(`${it.name} ${it.material_hint}`);
    if (keywords.length === 0) return [];
    const keywordSet = new Set(keywords);
    // A literal width token (e.g. "400mm") is a far stronger signal than any
    // ordinary word overlap — a bin, hamper, or any other width-coded fitting
    // can have several price-book variants that only differ by width, so a
    // generic product whose name happens to share a couple of plain words
    // (e.g. "pull", "out", "bin") must never outrank one whose width actually
    // matches the drawing. Without this, that's exactly what happened on a
    // real test: "400mm Pull-Out Bin" matched a generic "Finista...pull out
    // twin bin" instead of the price book's own "400mm Ninka 126 Bin".
    const WIDTH_TOKEN = /^\d+mm$/;
    return priceBook
      .filter((p) => !(p.category.toLowerCase() === "hardware" && /^drawer -/i.test(p.name)))
      .map((p) => ({
        p,
        score: materialKeywords(`${p.category} ${p.name}`)
          .filter((w) => keywordSet.has(w))
          .reduce((sum, w) => sum + (WIDTH_TOKEN.test(w) ? 5 : 1), 0),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((x) => x.p);
  }

  // A handful of accessory items have an established "pick this unless told
  // otherwise" default — the same pattern as defaulting to Merivo drawers
  // when no brand is nominated — rather than making the estimator choose
  // every time between several price-book options that only differ in size
  // or a detail the drawing never specifies. Only applies when the drawing
  // gives no more specific detail (a material_hint), since a called-out
  // model should still be free to match itself normally.
  function defaultAccessoryMatch(it: PlanItemResult): PriceBookItem | null {
    const name = it.name.toLowerCase();
    // A hanging rod only ever has one price-book line regardless of colour
    // or finish — "Black hanging rod" is still just a hanging rod — so this
    // one ignores material_hint entirely rather than only applying when the
    // schedule gave no extra detail.
    if (/hanging\s*rod|hanging\s*rail/.test(name)) {
      return priceBook.find((p) => p.name.toLowerCase().includes("hanging rail in laundry")) || null;
    }
    // Integrated appliances are priced as the joinery shop's "Integration
    // Service" line, never as a bin or a cabinet match.
    if (/fridge|freezer/.test(name)) {
      const french = /french/.test(`${name} ${it.material_hint}`.toLowerCase());
      const want = french ? "integration service - french door fridge" : "integration service - single fridge or freezer";
      return priceBook.find((p) => p.name.toLowerCase().includes(want)) || null;
    }
    if (/dishwasher|dish\s*drawer/.test(name)) {
      return priceBook.find((p) => p.name.toLowerCase().includes("integration service - dishwasher")) || null;
    }
    if (/shadow\s*line.*finger|finger rail/.test(name) && !it.material_hint.trim()) {
      return priceBook.find((p) => p.name.toLowerCase().includes("shadowline / finger rail small job")) || null;
    }
    if (/curved end.*tall|tall.*curved/.test(name)) {
      return priceBook.find((p) => p.name.toLowerCase().includes("curve - tall curved void box")) || null;
    }
    if (/curved end.*base|base.*curved/.test(name)) {
      return priceBook.find((p) => p.name.toLowerCase().includes("curve - island bench 900mm high x 450mm wide")) || null;
    }
    if (/^delivery\b/.test(name)) {
      return priceBook.find((p) => /^delivery city or hard access/i.test(p.name.trim())) || null;
    }
    if (/^drawers\b/.test(name)) {
      return findDrawerHardware(it.drawer_brand || "", /push.to.open|\bpto\b/.test(name));
    }
    if (/\bpto\b|push.to.open/.test(name)) {
      return priceBook.find((p) => p.name.toLowerCase().startsWith("touch catch (handle less)")) || null;
    }
    if (it.material_hint.trim()) return null;
    if (/hamper/.test(name)) {
      return priceBook.find((p) => p.name.toLowerCase().includes("finista edge uni-hamper 450")) || null;
    }
    if (/\bled\b/.test(name)) {
      return priceBook.find((p) => p.name.toLowerCase().includes("led extrusion with diffuser rebated")) || null;
    }
    return null;
  }

  // Splashbacks, stone benchtops, and tap/mixer installation are scope the
  // joinery shop coordinates and cuts for but doesn't supply or price itself
  // — these should still land on the quote (so nothing is missed) but with
  // no price expected, rather than being matched against the price book.
  function isNoPriceScopeItem(it: PlanItemResult): boolean {
    const text = `${it.name} ${it.material_hint}`.toLowerCase();
    return /splash\s*back|stone\s*benchtop|benchtop.*stone|\bmixer\b|tap\s*install/.test(text);
  }

  const MATERIAL_STOPWORDS = new Set([
    "mm", "with", "and", "the", "including", "collection", "series", "range", "doors", "door", "panel",
    "from", "white", "cabinet", "base", "wall", "tall", "open", "internal", "carcass", "stlyex", "stylex",
  ]);

  function materialKeywords(s: string): string[] {
    return s
      .toLowerCase()
      .replace(/[()/]/g, " ")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !MATERIAL_STOPWORDS.has(w));
  }

  // Matches the finish named on the drawing/schedule (material_hint) against
  // the price book by keyword overlap rather than requiring one string to
  // literally contain the other — real-world hints ("Farmers Slimlined
  // Natural Matte Limewash") rarely appear verbatim in a price book line
  // ("Base Cabinet - 22mm Farmers Doors Weathered Slimline Oak Stained"), so
  // a literal substring check almost never fires. Returns the best-scoring
  // option even on a weak match, plus whether that match is confident enough
  // to treat as exact — callers should still flag a non-exact match for the
  // estimator to confirm rather than silently trusting it.
  function bestMaterialMatch(options: PriceBookItem[], hint: string): { match: PriceBookItem | null; exact: boolean } {
    if (!hint.trim() || options.length === 0) return { match: null, exact: false };
    const hintWords = materialKeywords(hint);
    if (hintWords.length === 0) return { match: null, exact: false };
    const hintSet = new Set(hintWords);

    // Same width-token weighting as materialOptionsFor above, and for the
    // same reason: this function does its own independent scoring pass over
    // the shortlist, so without this it can still re-rank a generic product
    // above the one whose width actually matches the drawing.
    const WIDTH_TOKEN = /^\d+mm$/;
    let best: PriceBookItem | null = null;
    let bestScore = 0;
    for (const o of options) {
      const words = materialKeywords(o.name);
      const score = words.filter((w) => hintSet.has(w)).reduce((sum, w) => sum + (WIDTH_TOKEN.test(w) ? 5 : 1), 0);
      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }
    if (!best) return { match: null, exact: false };
    return { match: best, exact: bestScore >= 2 };
  }

  // Drawings/schedules often nominate a drawer system by a short code
  // rather than the full brand name (e.g. "ANT" for Blum Antaro), and the
  // price book itself spells one brand differently to how it's normally
  // written ("Anataro" rather than "Antaro"). Resolving through this table
  // first means both the abbreviation and the "correct" spelling still find
  // the price book's actual row.
  const DRAWER_BRAND_ALIASES: Record<string, string> = {
    ant: "anataro",
    antaro: "anataro",
    anataro: "anataro",
    mer: "merivo",
    merivo: "merivo",
    leg: "legrabox",
    legrabox: "legrabox",
    mov: "movento",
    movento: "movento",
  };

  // forcePto, when given, overrides whatever the brand text says — used when
  // splitting a mixed run into its standard and push-to-open portions, where
  // each portion's mechanism is already known from pto_drawer_count rather
  // than needing to be parsed back out of the brand string.
  function findDrawerHardware(brand: string, forcePto?: boolean): PriceBookItem | null {
    const raw = (brand.trim() || "Merivo").toLowerCase();
    const tokens = raw.split(/[^a-z0-9]+/).filter(Boolean);
    // "PTO" (push-to-open — no handle, opened by pressing the door/front) is
    // a mechanism choice noted alongside the brand code, not a brand itself
    // — e.g. "ANT PTO" — so it's pulled out separately rather than treated
    // as part of the brand text.
    const isPushToOpen =
      forcePto ?? (tokens.includes("pto") || raw.includes("push to open") || raw.includes("push-to-open"));
    // Keep both the original tokens and their alias resolutions so a
    // substring check below matches regardless of which spelling/code the
    // drawing used versus which spelling the price book uses.
    const hint = [...tokens, ...tokens.map((t) => DRAWER_BRAND_ALIASES[t] || t)].join(" ");
    const drawerItems = priceBook.filter((p) => p.category.toLowerCase() === "hardware" && /^drawer -/i.test(p.name));
    const matches = drawerItems.filter((p) => {
      const brandWord = p.name.replace(/^drawer\s*-\s*/i, "").split(/[\s(]/)[0].toLowerCase();
      return brandWord.length > 0 && hint.includes(brandWord);
    });
    const pool = matches.length > 0 ? matches : drawerItems.filter((p) => p.name.toLowerCase().includes("merivo"));
    if (isPushToOpen) {
      // Not every brand in the price book has its own push-to-open row —
      // fall back to that brand's standard row rather than silently
      // switching brands if one doesn't exist.
      return pool.find((c) => /push to open/i.test(c.name)) || pool[0] || null;
    }
    return pool.find((c) => !/push to open/i.test(c.name)) || pool[0] || null;
  }

  // Builds the amber confirmation note shown under a plan-read item: carries
  // forward anything the AI noted about the item, then explains how the
  // item got matched (or why it couldn't be) so the estimator knows exactly
  // what to double-check rather than just seeing a bare "confirm". Applies
  // to every item, not just cabinet runs — an unmatched laundry chute or
  // end panel needs the same kind of flag as an unmatched finish.
  function buildMaterialFlag(it: PlanItemResult, options: PriceBookItem[], matched: PriceBookItem | null, exact: boolean): string {
    const parts: string[] = [];
    if (it.note) parts.push(it.note);
    const hintText = [it.material_hint, it.name].filter(Boolean).join(" — ");
    if (matched && exact) {
      // Confident match — nothing further to add.
    } else if (matched && !exact) {
      parts.push(`Closest price-book match to "${hintText}" — confirm there's no cost delta for the exact item/finish.`);
    } else if (options.length > 0) {
      parts.push(`Could not confidently match "${hintText}" — please pick from the options below.`);
    } else {
      parts.push(`Not found in your price book — add pricing for this manually.`);
    }
    if (it.confidence === "low") parts.push("Low confidence — check on site.");
    return parts.join(" ");
  }

  function storagePathFor(userId: string, file: File) {
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    return `${userId}/${Date.now()}-${safeName}`;
  }

  // The model is asked (see PLAN_PROMPT) to report each wall's own
  // base/wall/tall band as its own atomic item, rather than attempting to
  // sum lengths/drawer counts across walls itself — it kept failing to hold
  // that arithmetic consistently across several simultaneous rules. Instead,
  // matching bands from different walls (same room, cabinet type, and open/
  // closed) are summed here, deterministically, right after the raw read
  // comes back and before anything downstream (selection, material
  // matching, defaults) ever sees the un-merged items. Discrete fittings/
  // QTY/MISC items are left alone — those are already meant to be one item
  // per instance, not one per wall.
  //
  // Neither drawer brand nor material_hint is part of the grouping key: a
  // room's base/wall/tall cabinetry is overwhelmingly one finish throughout
  // (per PLAN_PROMPT's own instruction to the model), but the model doesn't
  // always phrase that finish identically for every wall it reads, and an
  // estimator wants ONE base/wall/tall line per room with one material
  // picker, not a second line every time the wording drifts. So every
  // base/wall/tall item in the same room (of the same cabinet_type and
  // open/closed) is combined into one, and the most complete material_hint
  // and all distinct drawer brands seen are carried onto that one merged
  // item instead.
  // Runs BEFORE mergePlanBands. The model is told to use one consistent
  // room name for every item in a single-room document, but doesn't always
  // hold that consistency — in practice a generic category word like
  // "Kitchen" is the most common wrong label, inferred from an appliance
  // (a fridge/dishwasher) rather than read off the sheet's actual title.
  // When the exact same physical run (identical name + cabinet_type +
  // material_hint) is filed under two different room labels, that's
  // unambiguous: it's one run counted twice under two names, not two
  // separate rooms each with their own cabinetry — so those get folded
  // back onto a single label here, before mergePlanBands ever groups by
  // room (otherwise they'd survive as two separate line items in two
  // separate room sections on the exported quote, instead of one).
  function reconcileRoomLabels(items: PlanItemResult[]): { items: PlanItemResult[]; roomLabels: string[] } {
    const GENERIC_INFERRED_WORDS = new Set(["kitchen", "laundry", "bathroom", "ensuite", "toilet", "wc"]);
    const dupKey = (it: PlanItemResult) =>
      [it.name.trim().toLowerCase(), it.cabinet_type, it.material_hint.trim().toLowerCase()].join("|");

    const groups = new Map<string, PlanItemResult[]>();
    items.forEach((it) => {
      const room = (it.room || "").trim();
      if (!room || room === "General") return;
      const key = dupKey(it);
      const g = groups.get(key) || [];
      g.push(it);
      groups.set(key, g);
    });

    const relabel = new Map<PlanItemResult, string>();
    groups.forEach((group) => {
      const rooms = new Set(group.map((it) => it.room.trim()));
      if (rooms.size <= 1) return; // already consistent — nothing to reconcile

      // Winning label: most frequent among this duplicate's own
      // occurrences; ties go against a generic, appliance-inferable word
      // in favour of whatever more specific label was also used.
      const counts = new Map<string, number>();
      group.forEach((it) => counts.set(it.room.trim(), (counts.get(it.room.trim()) || 0) + 1));
      let winner = "";
      let winnerCount = -1;
      counts.forEach((count, room) => {
        const winnerIsGeneric = GENERIC_INFERRED_WORDS.has(winner.toLowerCase());
        const roomIsGeneric = GENERIC_INFERRED_WORDS.has(room.toLowerCase());
        if (count > winnerCount || (count === winnerCount && winnerIsGeneric && !roomIsGeneric)) {
          winner = room;
          winnerCount = count;
        }
      });
      group.forEach((it) => relabel.set(it, winner));
    });

    const reconciled = items.map((it) => (relabel.has(it) ? { ...it, room: relabel.get(it)! } : it));
    const roomLabels = Array.from(
      new Set(reconciled.map((it) => (it.room || "").trim()).filter((r) => r && r !== "General"))
    );
    return { items: reconciled, roomLabels };
  }

  // Deterministic cross-check, not another prompt tweak: real tests kept showing
  // the same pattern — most items on a page get a tight, correct box, but one or
  // two land in the blank gap below the actual drawing (above the title block),
  // even though the prompt explicitly says not to box blank space. Rather than
  // trust the model to police itself here, compare each item's box against
  // where every OTHER item on the same page landed; one sitting well below the
  // rest is almost certainly in that blank gap, not on real cabinetry.
  function isRegionSuspect(page: number, bbox: [number, number, number, number]): boolean {
    if (!planResult) return false;
    const otherBottoms: number[] = [];
    for (const it of planResult.items) {
      for (const r of it.regions || []) {
        if (r.page === page && r.bbox !== bbox) otherBottoms.push(r.bbox[3]);
      }
    }
    if (otherBottoms.length < 2) return false; // not enough on this page to compare against
    const sorted = [...otherBottoms].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    // This box starts noticeably below where most other items on the page ended.
    return bbox[1] - median > 0.12;
  }

  async function showRegionAt(itemName: string, regions: { page: number; bbox: [number, number, number, number] }[], index: number) {
    if (!lastPlanFile) {
      setRegionPreview({
        itemName,
        regions,
        index,
        imageUrl: null,
        loading: false,
        error: "The plan file isn't available anymore in this session — re-upload the plan to use this preview.",
        suspect: false,
      });
      return;
    }
    const suspect = isRegionSuspect(regions[index].page, regions[index].bbox);
    setRegionPreview({ itemName, regions, index, imageUrl: null, loading: true, error: null, suspect });
    try {
      const url = await renderPlanRegionPreview(lastPlanFile, regions[index].page, regions[index].bbox);
      setRegionPreview((prev) => (prev ? { ...prev, imageUrl: url, loading: false } : prev));
    } catch (err) {
      setRegionPreview((prev) =>
        prev
          ? { ...prev, loading: false, error: err instanceof Error ? err.message : "Could not render this page." }
          : prev
      );
    }
  }

  function openRegionPreview(it: PlanItemResult) {
    if (!it.regions || it.regions.length === 0) return;
    showRegionAt(it.name, it.regions, 0);
  }

  function stepRegionPreview(delta: number) {
    setRegionPreview((prev) => {
      if (!prev) return prev;
      const nextIndex = Math.max(0, Math.min(prev.regions.length - 1, prev.index + delta));
      if (nextIndex === prev.index) return prev;
      showRegionAt(prev.itemName, prev.regions, nextIndex);
      return { ...prev, index: nextIndex, loading: true, imageUrl: null };
    });
  }

  function closeRegionPreview() {
    setRegionPreview(null);
  }

  // One click: draw every item's box on its page, colour-coded and numbered,
  // and show the pages together with a legend. Only the first region of each
  // item is drawn (an item drawn on several pages appears on each of them).
  async function openAllRegions() {
    if (!planResult) return;
    if (!lastPlanFile) {
      setOverview({
        loading: false,
        error: "The plan file isn't available anymore in this session — re-upload the plan to use this view.",
        pages: [],
        legend: [],
        noRegions: [],
      });
      return;
    }
    const legend: { n: number; name: string; qty: string; page: number; suspect: boolean }[] = [];
    const byPage = new Map<number, { n: number; bbox: [number, number, number, number] }[]>();
    const noRegions: string[] = [];
    let n = 0;
    for (const it of planResult.items) {
      if (!it.regions || it.regions.length === 0) {
        noRegions.push(it.name);
        continue;
      }
      n += 1;
      const qty = it.calc === "LM" ? `${it.qty} ${it.unit || "lm"}` : `${it.qty} ${it.unit || "ea"}`;
      const primaryPage = it.regions[0].page;
      legend.push({
        n,
        name: it.name,
        qty,
        page: primaryPage,
        suspect: it.regions.some((r) => isRegionSuspect(r.page, r.bbox)),
      });
      for (const r of it.regions) {
        const arr = byPage.get(r.page) || [];
        arr.push({ n, bbox: r.bbox });
        byPage.set(r.page, arr);
      }
    }
    const pageNumbers = Array.from(byPage.keys()).sort((a, b) => a - b);
    setOverview({
      loading: true,
      error: null,
      pages: pageNumbers.map((p) => ({ page: p, imageUrl: null, error: null })),
      legend,
      noRegions,
    });
    for (const p of pageNumbers) {
      try {
        const url = await renderPlanOverview(lastPlanFile, p, byPage.get(p)!);
        setOverview((prev) =>
          prev ? { ...prev, pages: prev.pages.map((pg) => (pg.page === p ? { ...pg, imageUrl: url } : pg)) } : prev
        );
      } catch (err) {
        setOverview((prev) =>
          prev
            ? {
                ...prev,
                pages: prev.pages.map((pg) =>
                  pg.page === p
                    ? { ...pg, error: err instanceof Error ? err.message : "Could not render this page." }
                    : pg
                ),
              }
            : prev
        );
      }
    }
    setOverview((prev) => (prev ? { ...prev, loading: false } : prev));
  }

  function mergePlanBands(items: PlanItemResult[]): PlanItemResult[] {
    const mergeable = (it: PlanItemResult) =>
      it.calc === "LM" && (it.cabinet_type === "base" || it.cabinet_type === "wall" || it.cabinet_type === "tall");
    const keyOf = (it: PlanItemResult) =>
      [it.room.trim().toLowerCase(), it.cabinet_type, it.open ? "open" : "closed"].join("|");

    // Location keywords checked for repeats below — a real room essentially
    // never has two walls both describable as "the front wall" or both as
    // "the return wall", so if a merge group's notes mention the same one
    // of these more than once, that's a strong, cheap, deterministic signal
    // the model reported one physical wall twice under different wording
    // (exactly the bug that caused the Pantry test's Base/Wall overcounts),
    // rather than genuinely two different walls. This catches that pattern
    // without needing to know the plan's real wall count.
    const LOCATION_WORDS = ["front", "return", "rear", "back", "middle", "island"];

    const sums = new Map<
      string,
      {
        qty: number;
        drawer_count: number;
        pto_drawer_count: number;
        notes: string[];
        confidences: string[];
        brands: string[];
        bestHint: string;
        regions: { page: number; bbox: [number, number, number, number] }[];
      }
    >();
    for (const it of items) {
      if (!mergeable(it)) continue;
      const key = keyOf(it);
      const s =
        sums.get(key) ||
        {
          qty: 0,
          drawer_count: 0,
          pto_drawer_count: 0,
          notes: [] as string[],
          confidences: [] as string[],
          brands: [] as string[],
          bestHint: "",
          regions: [] as { page: number; bbox: [number, number, number, number] }[],
        };
      s.qty += it.qty || 0;
      s.drawer_count += it.drawer_count || 0;
      s.pto_drawer_count += it.pto_drawer_count || 0;
      const note = it.note.trim();
      if (note && !s.notes.includes(note)) s.notes.push(note);
      s.confidences.push(it.confidence);
      const brand = it.drawer_brand.trim();
      if (brand && !s.brands.some((b) => b.toLowerCase() === brand.toLowerCase())) s.brands.push(brand);
      // The most detailed (longest) material_hint across the room's
      // same-type items wins — a wall that got its finish fully described
      // shouldn't lose to a wall where the model only wrote a few words.
      if (it.material_hint.trim().length > s.bestHint.length) s.bestHint = it.material_hint.trim();
      if (Array.isArray(it.regions)) s.regions.push(...it.regions);
      sums.set(key, s);
    }

    const emitted = new Set<string>();
    const merged: PlanItemResult[] = [];
    for (const it of items) {
      if (!mergeable(it)) {
        merged.push(it);
        continue;
      }
      const key = keyOf(it);
      if (emitted.has(key)) continue; // later walls' figures are folded into the first occurrence below
      emitted.add(key);
      const s = sums.get(key)!;
      const confidence = s.confidences.includes("low") ? "low" : s.confidences.includes("medium") ? "medium" : "high";

      // Flag any location word that shows up in more than one of the
      // distinct notes feeding this merged item — see LOCATION_WORDS above.
      const repeatedWords = LOCATION_WORDS.filter((word) => {
        const re = new RegExp(`\\b${word}\\b`, "i");
        return s.notes.filter((n) => re.test(n)).length >= 2;
      });
      const duplicateWallWarning =
        repeatedWords.length > 0
          ? `Combined from ${s.notes.length} plan entries, and more than one mentions "${repeatedWords.join(
              '" / "'
            )}" — check this isn't the same wall counted twice before pricing.`
          : undefined;

      merged.push({
        ...it,
        qty: Math.round(s.qty * 1000) / 1000,
        drawer_count: s.drawer_count,
        pto_drawer_count: s.pto_drawer_count,
        drawer_brand: s.brands.join(" / ") || it.drawer_brand,
        material_hint: s.bestHint || it.material_hint,
        note: s.notes.join("; "),
        confidence,
        duplicate_wall_warning: duplicateWallWarning,
        regions: s.regions,
      });
    }
    return merged;
  }

  // Deterministic measuring: the model transcribes each elevation's column
  // widths (printed figures) and what kind of cabinetry each column is; the
  // base / wall / tall lm totals are then added up HERE, not by the model.
  // Repeated real tests showed the model getting the arithmetic and the
  // classification wrong at the same time (e.g. base and wall both coming out
  // as the full wall width). A checksum — column widths must add up to the
  // elevation's printed overall dimension — catches misread columns; a wall
  // that fails it is NOT used to override anything and is flagged instead.
  // A sheet whose title matches none of the AI's rooms (so no item of that room exists yet) still
  // gets its measured lengths: a blank line is built from any other item and given the sheet's room.
  function blankRoomItem(items: PlanItemResult[], display: string): PlanItemResult | undefined {
    const any = items[0];
    if (!any) return undefined;
    const room = display.replace(/^\(sheet\)\s*/i, "").toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
    return {
      ...any,
      room,
      calc: "LM" as const,
      cabinet_type: "base",
      qty: 0,
      unit: "lm",
      open: false,
      drawer_count: 0,
      pto_drawer_count: 0,
      material_hint: "",
      regions: [],
      note: "",
      duplicate_wall_warning: undefined,
    };
  }

  // Standard delivery allowances (Vicello convention): kitchens and pantries 1x / 1.5x / 2x by size,
  // 1x per walk-in robe, and at least 1.5x across the other robes together.
  function addStandardDelivery(items: PlanItemResult[]): PlanItemResult[] {
    if (items.length === 0 || items.some((it) => /^delivery\b/i.test(it.name))) return items;
    const rooms = new Map<string, PlanItemResult[]>();
    for (const it of items) {
      const k = it.room.trim();
      if (!k) continue;
      rooms.set(k, [...(rooms.get(k) || []), it]);
    }
    const out = [...items];
    const mk = (room: string, qty: number, note: string): PlanItemResult => ({
      ...(rooms.get(room)![0]),
      name: "Delivery",
      cabinet_type: "other",
      calc: "QTY",
      qty,
      unit: "ea",
      material_hint: "",
      open: false,
      drawer_count: 0,
      pto_drawer_count: 0,
      drawer_brand: "",
      note,
      confidence: "medium",
      duplicate_wall_warning: undefined,
      regions: [],
    });
    let robeRoom = "";
    rooms.forEach((its, room) => {
      const lm = its.filter((i) => i.calc === "LM" && ["base", "wall", "tall"].includes(i.cabinet_type)).reduce((a, i) => a + i.qty, 0);
      if (/kitchen|pantry|scullery/i.test(room)) {
        const qty = lm > 16 ? 2 : lm > 8 ? 1.5 : 1;
        out.push(mk(room, qty, `Standard delivery allowance: ${qty}x for a ${qty === 2 ? "large" : qty === 1.5 ? "medium" : "standard"} ${/pantry/i.test(room) ? "pantry" : "kitchen"} (${Math.round(lm * 100) / 100} lm of cabinetry; over 8 lm = medium, over 16 lm = large)`));
      } else if (/\bwir\b|walk[\s-]*in[\s-]*(robe|wardrobe)/i.test(room)) {
        out.push(mk(room, 1, "Standard delivery allowance: 1x for a walk-in robe"));
      } else if (/wardrobe|robe|\bbed\b|\bbed\s*\d/i.test(room) && !/vanity|bath|ensuite/i.test(room) && !robeRoom) {
        robeRoom = room;
      }
    });
    if (robeRoom) out.push(mk(robeRoom, 1.5, "Standard delivery allowance: at least 1.5x across the other robes together"));
    return out;
  }

  function applyColumnInventory(
    items: PlanItemResult[],
    walls:
      | { room?: string; name?: string; page?: number; overall_mm?: number; columns?: { width_mm: number; kind: string; label?: string }[]; geom?: ColumnGeom }[]
      | undefined
  ): { items: PlanItemResult[]; report: ColumnReport[]; warnings: string[] } {
    const report: ColumnReport[] = [];
    const warnings: string[] = [];
    if (!Array.isArray(walls) || walls.length === 0) return { items, report, warnings };

    const lmItems = items.filter((it) => it.calc === "LM" && ["base", "wall", "tall"].includes(it.cabinet_type));
    const itemRooms = Array.from(new Set(lmItems.map((it) => it.room.trim().toLowerCase())));

    const totals = new Map<string, { base: number; wall: number; tall: number; parts: { base: string[]; wall: string[]; tall: string[] }; room: string; display: string; det: boolean; allDet: boolean; ledMm: number; ledPages: number[] }>();
    for (const w of walls) {
      const cols = (Array.isArray(w.columns) ? w.columns : []).map((c) => ({
        width_mm: Number(c.width_mm) || 0,
        kind: String(c.kind || "").toLowerCase(),
        label: c.label || "",
      }));
      if (cols.length === 0) continue;
      const sum = cols.reduce((a, c) => a + c.width_mm, 0);
      const overall = Number(w.overall_mm) || 0;
      const hasZero = cols.some((c) => c.width_mm <= 0 && c.kind !== "gap");
      const ok = !hasZero && (overall > 0 ? Math.abs(sum - overall) <= 2 : false);
      const sumOf = (kinds: string[]) => cols.filter((c) => kinds.includes(c.kind)).reduce((a, c) => a + c.width_mm, 0);
      const snapToOverall = (v: number) => (ok && v === sum && overall > 0 ? overall : v);
      // A printed segment (e.g. the shaving cabinet's 1,339) beats the columns' rounded sum.
      const printedWall = w.geom?.det?.printed?.wall;
      const wallRaw = sumOf(["base_wall", "wall", "tall_wall"]);
      const wallFinal = printedWall && Math.abs(printedWall - wallRaw) <= 3 ? printedWall : snapToOverall(wallRaw);
      const rep: ColumnReport = {
        name: w.name || "Wall",
        room: w.room || "",
        page: Number(w.page) || 0,
        overall,
        sum,
        ok,
        columns: cols,
        geom: w.geom,
        // When every column belongs to the band, the printed overall (e.g. 1890) is the
        // answer, not the columns' rounded sum (1889).
        base: snapToOverall(sumOf(["base", "base_wall"])),
        wall: wallFinal,
        tall: snapToOverall(sumOf(["tall", "tall_wall"])),
      };
      report.push(rep);
      if (!ok) {
        warnings.push(
          `${rep.name}: the column widths (${cols.map((c) => c.width_mm).join(" + ")} = ${sum}mm) don't add up to the printed overall ${
            overall || "(none printed)"
          }mm — a column was probably misread or missed, so the measured lengths for this wall were NOT applied. Check it against the drawing.`
        );
        continue;
      }
      // Which room does this wall belong to?
      let roomKey = (w.room || "").trim().toLowerCase();
      if (!itemRooms.includes(roomKey)) roomKey = itemRooms.length === 1 ? itemRooms[0] : roomKey;
      const t =
        totals.get(roomKey) ||
        { base: 0, wall: 0, tall: 0, parts: { base: [], wall: [], tall: [] }, room: roomKey, display: (w.room || roomKey).trim(), det: false, allDet: true, ledMm: 0, ledPages: [] };
      if (w.geom?.led) {
        t.ledMm += overall;
        t.ledPages.push(Number(w.page) || 0);
      }
      if (w.geom?.det) t.det = true;
      else t.allDet = false;
      t.base += rep.base;
      t.wall += rep.wall;
      t.tall += rep.tall;
      const widths = (kinds: string[]) => cols.filter((c) => kinds.includes(c.kind)).map((c) => c.width_mm).join(" + ");
      if (rep.base > 0) t.parts.base.push(`${rep.name}: ${widths(["base", "base_wall"])}`);
      if (rep.wall > 0) t.parts.wall.push(`${rep.name}: ${widths(["base_wall", "wall", "tall_wall"])}`);
      if (rep.tall > 0) t.parts.tall.push(`${rep.name}: ${widths(["tall", "tall_wall"])}`);
      totals.set(roomKey, t);
    }

    let out = [...items];
    const createdBase = new Set<string>();
    const dropItems = new Set<PlanItemResult>();
    for (const [roomKey, t] of totals) {
      for (const type of ["base", "wall", "tall"] as const) {
        const metres = Math.round(t[type]) / 1000;
        const existingIdx = out.findIndex(
          (it) => it.calc === "LM" && it.cabinet_type === type && it.room.trim().toLowerCase() === roomKey
        );
        const colNote = t.parts[type].length > 0 ? `columns (mm) — ${t.parts[type].join("; ")}${t.det ? " — read from the drawing's own height chain and labels" : ""}` : "";
        if (metres > 0 && existingIdx >= 0) {
          const it = out[existingIdx];
          const aiQty = it.qty;
          const diff = Math.abs(aiQty - metres) > 0.01 ? ` (AI's own figure was ${aiQty}; replaced by the column sum)` : "";
          out[existingIdx] = {
            ...it,
            qty: metres,
            note: [it.note, colNote + diff].filter(Boolean).join("; "),
            duplicate_wall_warning: undefined,
          };
        } else if (metres > 0) {
          // Falls back to ANY item in the room (e.g. a room where the AI listed only a fitting
          // or a vanity) so the measured lengths are never silently dropped.
          const template =
            out.find((it) => it.calc === "LM" && it.room.trim().toLowerCase() === roomKey && it.cabinet_type === "base") ||
            out.find((it) => it.calc === "LM" && it.room.trim().toLowerCase() === roomKey) ||
            out.find((it) => it.room.trim().toLowerCase() === roomKey && !/stone|by others/i.test(it.name)) ||
            out.find((it) => it.room.trim().toLowerCase() === roomKey) ||
            blankRoomItem(out, t.display);
          if (template) {
            if (type === "base") createdBase.add(roomKey);
            out.push({
              ...template,
              calc: "LM" as const,
              material_hint: template.calc === "LM" ? template.material_hint : "",
              name: type === "base" ? "Base cabinet" : type === "wall" ? "Wall cabinet" : "Tall cabinet",
              cabinet_type: type,
              qty: metres,
              unit: "lm",
              open: false,
              drawer_count: 0,
              pto_drawer_count: 0,
              drawer_brand: "",
              note: `${colNote} (added from the column inventory — the AI hadn't listed this item)`,
              confidence: "medium",
              duplicate_wall_warning: undefined,
              regions: [],
            });
          }
        } else if (existingIdx >= 0) {
          if (t.allDet) {
            // Every sheet of this room was read from the drawing's own height chain: it shows no
            // such cabinets, so the AI's item is dropped rather than left to be priced.
            dropItems.add(out[existingIdx]);
            warnings.push(`${out[existingIdx].room}: removed the AI's ${type} cabinet (${out[existingIdx].qty} lm) — the drawing's own heights and labels show no ${type} cabinets there.`);
          } else {
            warnings.push(
              `The column inventory found no ${type} columns, but a ${type} cabinet item was listed (${out[existingIdx].qty} lm) — check it.`
            );
          }
        }
      }
    }
    // LED noted on a sheet: the aluminium channel is priced too. Its length isn't printed, so it is
    // taken as the run's overall width on each sheet that carries an LED note — flagged to check.
    for (const [roomKey, t] of totals) {
      if (t.ledMm <= 0) continue;
      if (out.some((it) => it.room.trim().toLowerCase() === roomKey && /\bled\b/i.test(it.name))) continue;
      const template = out.find((it) => it.room.trim().toLowerCase() === roomKey) || blankRoomItem(out, t.display);
      if (!template) continue;
      const metres = Math.round(t.ledMm) / 1000;
      out.push({
        ...template,
        name: "LED channel",
        cabinet_type: "other",
        calc: "QTY" as const,
        qty: Math.ceil(metres / 2.4 - 1e-9),
        unit: "ea",
        material_hint: "",
        open: false,
        drawer_count: 0,
        pto_drawer_count: 0,
        drawer_brand: "",
        note: `LED noted on the drawing (sheet ${Array.from(new Set(t.ledPages)).join(", ")}) — ${metres} lm assumed (full width of each elevation showing LED) ÷ 2.4 m channel lengths, rounded up; check it`,
        confidence: "low",
        duplicate_wall_warning: undefined,
        regions: [],
      });
    }
    if (dropItems.size > 0) out = out.filter((it) => !dropItems.has(it));
    // A vanity the AI listed as ONE unit is replaced by the measured base / wall lengths
    // (and the drawers line), so it isn't priced twice.
    createdBase.forEach((roomKey) => {
      const dropped = out.filter((it) => it.room.trim().toLowerCase() === roomKey && it.calc === "QTY" && it.cabinet_type === "other" && /vanity/i.test(it.name));
      if (dropped.length > 0) {
        out = out.filter((it) => !dropped.includes(it));
        warnings.push(`${dropped[0].room}: replaced the AI's "${dropped[0].name}" (${dropped[0].qty} ${dropped[0].unit}) with the measured Base / Wall cabinet lengths and the drawers line.`);
      }
    });
    return { items: out, report, warnings };
  }

  // Another deterministic cross-check, not a prompt tweak: a real test on the
  // Imola Pantry plan showed Wall cabinets come out to the exact same figure
  // as Base cabinets in the same room (3.758 both), which is the tell for the
  // model having copied one band's width onto the other rather than measuring
  // the wall band's own extent — base and wall almost never span the identical
  // width in practice, since appliances, end panels, and windows typically
  // interrupt one band but not the other. Flag it rather than silently
  // trusting it.
  function flagMatchingBandLengths(items: PlanItemResult[]): PlanItemResult[] {
    const byRoom = new Map<string, PlanItemResult[]>();
    for (const it of items) {
      if (it.calc !== "LM") continue;
      if (it.cabinet_type !== "base" && it.cabinet_type !== "wall" && it.cabinet_type !== "tall") continue;
      const key = it.room.trim().toLowerCase();
      const arr = byRoom.get(key) || [];
      arr.push(it);
      byRoom.set(key, arr);
    }
    const flagged = new Set<PlanItemResult>();
    for (const group of byRoom.values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i];
          const b = group[j];
          const measured = /height chain/i.test(a.note) && /height chain/i.test(b.note);
          if (!measured && a.qty > 0 && Math.abs(a.qty - b.qty) < 0.001) {
            flagged.add(a);
            flagged.add(b);
          }
        }
      }
    }
    if (flagged.size === 0) return items;
    return items.map((it) =>
      flagged.has(it)
        ? {
            ...it,
            duplicate_wall_warning: it.duplicate_wall_warning
              ? `${it.duplicate_wall_warning} Also: this came out the exact same length as another band in the same room — check it wasn't copied from that band instead of measured on its own.`
              : "This came out the exact same length as another band (base/wall/tall) in the same room — check it wasn't copied from that band instead of measured on its own.",
          }
        : it
    );
  }

  type PdfPicker = {
    target: "plan" | "schedule";
    file: File;
    pageCount: number;
    selectedPages: Set<number>; // 0-indexed
    pagesInput: string;
    thumbnails: string[]; // data URLs, "" until that page has rendered
    busy: boolean;
    error: string | null;
  };
  const [pdfPicker, setPdfPicker] = useState<PdfPicker | null>(null);

  // Places "View on plan" boxes from the drawing's own geometry instead of the
  // AI's guess: each column's horizontal position (from the dimension string),
  // the elevation's top and floor (from its tall vertical dimension), and what
  // the column is (its type and printed notes). Items that can't be anchored
  // keep the AI's own regions.
  function anchorRegions(items: PlanItemResult[], report: ColumnReport[]): PlanItemResult[] {
    const walls = report.filter((w) => w.geom && w.geom.frame && w.geom.cols.length === w.columns.length);
    if (walls.length === 0) return items;
    const PAD = 0.004;
    let curRoom = ""; // the item being placed — only walls from its own room may take its boxes
    type Box = { page: number; bbox: [number, number, number, number] };
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    // contiguous runs of matching columns (a narrow gap between two matches joins them)
    const runs = (w: ColumnReport, pick: (c: ColumnReport["columns"][number], i: number) => boolean) => {
      const out: [number, number][] = [];
      let start = -1;
      let last = -1;
      w.columns.forEach((c, i) => {
        if (pick(c, i)) {
          if (start < 0) start = i;
          last = i;
        } else if (!(c.kind === "gap" && start >= 0)) {
          if (start >= 0) out.push([start, last]);
          start = -1;
        }
      });
      if (start >= 0) out.push([start, last]);
      return out;
    };
    const boxesFor = (
      pick: (c: ColumnReport["columns"][number], i: number) => boolean,
      zone: (k: number, top: number, bottom: number) => [number, number],
      band?: "base" | "wall" | "tall"
    ): Box[] => {
      const boxes: Box[] = [];
      for (const w of walls) {
        if (curRoom && w.room && w.room.trim().toLowerCase() !== curRoom) continue;
        const g = w.geom!;
        const f = g.frame!;
        const det = g.det;
        const k = det ? det.k : (f.bottom - f.top) / f.mm; // page-height fraction per mm
        // Bands read from the drawing's own height chain give the exact vertical extent.
        const detBand = det && band ? det.bands.find((b) => b.kind === band) : undefined;
        if (det && band && !detBand) continue;
        for (const [a, b] of runs(w, pick)) {
          const [y0, y1] = detBand && det
            ? [det.floor - Math.min(detBand.hi, band === "base" ? 1100 : detBand.hi) * k, det.floor - detBand.lo * k]
            : zone(k, f.top, f.bottom);
          boxes.push({
            page: g.page,
            bbox: [clamp(g.cols[a].x0 - PAD), clamp(y0 - PAD), clamp(g.cols[b].x1 + PAD), clamp(y1 + PAD)],
          });
        }
      }
      return boxes;
    };
    const baseZone = (k: number, _t: number, bottom: number): [number, number] => [bottom - 930 * k, bottom];
    const wallZone = (k: number, top: number, bottom: number): [number, number] => [top, bottom - 1500 * k];
    const fullZone = (_k: number, top: number, bottom: number): [number, number] => [top, bottom];
    const fridgeZone = (k: number, _t: number, bottom: number): [number, number] => [bottom - 1800 * k, bottom];
    const ptoZone = (k: number, top: number, bottom: number): [number, number] => [top, bottom - 1800 * k];
    const has = (c: { label?: string }, re: RegExp) => re.test((c.label || "").toUpperCase());

    return items.map((it) => {
      const name = it.name.toLowerCase();
      curRoom = (it.room || "").trim().toLowerCase();
      let boxes: Box[] = [];
      if (it.calc === "LM" && it.cabinet_type === "base") boxes = boxesFor((c) => c.kind === "base" || c.kind === "base_wall", baseZone, "base");
      else if (it.calc === "LM" && it.cabinet_type === "wall")
        boxes = boxesFor((c) => c.kind === "base_wall" || c.kind === "wall" || c.kind === "tall_wall", wallZone, "wall");
      else if (it.calc === "LM" && it.cabinet_type === "tall") boxes = boxesFor((c) => c.kind === "tall" || c.kind === "tall_wall", fullZone, "tall");
      else if (/fridge|freezer/.test(name)) boxes = boxesFor((c) => has(c, /FRIDGE|FREEZER/), fridgeZone);
      else if (/dish/.test(name)) boxes = boxesFor((c) => has(c, /DISH/), baseZone);
      else if (/\bbin\b/.test(name)) boxes = boxesFor((c) => has(c, /\bBIN\b/), baseZone);
      else if (/^drawers\b/.test(name)) boxes = boxesFor((c) => has(c, /\bDEEP\b/), baseZone);
      else if (/\bpto\b|push.to.open/.test(name)) boxes = boxesFor((c) => has(c, /\bPTO\b/), ptoZone);
      return boxes.length > 0 ? { ...it, regions: boxes } : it;
    });
  }

  // Drawers get their own line in the list (so they can't be missed), priced
  // from the drawer hardware rows, instead of being a hidden count on the
  // cabinet run. The run's own drawer count is cleared so nothing is priced twice.
  function splitDrawersOut(items: PlanItemResult[]): PlanItemResult[] {
    const out: PlanItemResult[] = [];
    for (const it of items) {
      if (it.calc !== "LM" || !(it.drawer_count > 0)) {
        out.push(it);
        continue;
      }
      const pto = Math.min(it.pto_drawer_count || 0, it.drawer_count);
      const standard = it.drawer_count - pto;
      const brand = (it.drawer_brand || "").trim() || "Merivo";
      out.push({ ...it, drawer_count: 0, pto_drawer_count: 0 });
      const base = {
        ...it,
        cabinet_type: "other" as const,
        calc: "QTY" as const,
        unit: "ea",
        material_hint: "",
        drawer_count: 0,
        pto_drawer_count: 0,
        open: false,
        duplicate_wall_warning: undefined,
        confidence: "high" as const,
        regions: it.regions,
      };
      const where = `${it.name.toLowerCase()} run${it.cabinet_type === "tall" ? " (TALL)" : ""}`;
      if (standard > 0) {
        out.push({ ...base, name: `Drawers — ${brand}`, qty: standard, note: `${standard} drawers on the ${where}`, drawer_brand: it.drawer_brand });
      }
      if (pto > 0) {
        out.push({ ...base, name: `Drawers — ${brand} push-to-open`, qty: pto, note: `${pto} push-to-open drawers on the ${where}`, drawer_brand: it.drawer_brand });
      }
    }
    return out;
  }

  // Counts read straight from the PDF's printed text (drawer-depth tags such as
  // 'B' 350 DEEP, and PTO notes) — these override the AI's estimates and are
  // noted on the items so they can be checked.
  // Walls read from the PDF text carry no room name. On a multi-room set, give each wall
  // the room whose items are drawn on that wall's page, so lengths/drawers/PTO land on
  // the right room instead of being dropped.
  function assignWallRooms(
    items: PlanItemResult[],
    walls: { room?: string; page?: number }[] | undefined,
    pageRoom: Map<number, string>,
    pageTitles?: Map<number, string>
  ) {
    if (!Array.isArray(walls)) return;
    const rooms = new Map<string, Map<number, number>>();
    items.forEach((it) => {
      const room = it.room.trim();
      if (!room) return;
      const m = rooms.get(room) || new Map<number, number>();
      (it.regions || []).forEach((r) => m.set(r.page, (m.get(r.page) || 0) + 1));
      rooms.set(room, m);
    });
    if (rooms.size <= 1) return;
    walls.forEach((w) => {
      const pg = w.page || 1;
      // The sheet's own title block is the most reliable answer.
      const byTitle = pageRoom.get(pg);
      if (byTitle) {
        w.room = byTitle;
        return;
      }
      // The sheet is titled for a room none of the listed items belong to: keep its walls out
      // of every other room rather than guessing a neighbour.
      const ownTitle = pageTitles?.get(pg);
      if (ownTitle) {
        w.room = `(sheet) ${ownTitle}`;
        return;
      }
      if (w.room && rooms.has(w.room.trim())) return;
      let best = "";
      let bestScore = 0;
      rooms.forEach((m, room) => {
        const score = m.get(pg) || 0;
        if (score > bestScore) {
          best = room;
          bestScore = score;
        }
      });
      if (!best) {
        let bestD = Infinity;
        rooms.forEach((m, room) => m.forEach((_c, page) => {
          const d = Math.abs(page - pg);
          if (d < bestD) {
            bestD = d;
            best = room;
          }
        }));
      }
      if (best) w.room = best;
    });
  }

  // page -> item room, matched from each sheet's title ("MASTER BED WIR" ↔ room "Master Bed WIR").
  function roomsByPageTitle(items: PlanItemResult[], titles: Map<number, string>): Map<number, string> {
    const tok = (t: string) => new Set(t.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().split(" ").filter(Boolean));
    const labels = Array.from(new Set(items.map((it) => it.room.trim()).filter(Boolean)));
    const out = new Map<number, string>();
    titles.forEach((title, page) => {
      const tt = tok(title);
      let best = "";
      let bestScore = 0;
      labels.forEach((l) => {
        const lt = tok(l);
        let inter = 0;
        tt.forEach((x) => lt.has(x) && inter++);
        let score = inter / (tt.size + lt.size - inter || 1);
        // "MASTER BED WIR" vs "MASTER BED VANITY" share half their words but are different rooms:
        // a half match only counts when one name is wholly contained in the other.
        if (score <= 0.5 && inter < Math.min(tt.size, lt.size)) score = 0;
        if (score > bestScore) {
          best = l;
          bestScore = score;
        }
      });
      if (best && bestScore >= 0.5) out.set(page, best);
      // A sheet titled for a room none of the AI's items carry still gets its own room, so its
      // measured lengths and drawers are kept (and not poured into a neighbouring room).
      else if (labels.length > 1 && /[A-Z]{3}/i.test(title) && !/\b(PLAN|COVER|INDEX|SCHEDULE|NOTES)\b/i.test(title))
        out.set(page, title.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()));
    });
    return out;
  }

  // Keep an item's boxes only on sheets titled for its own room; if none are left, point at its own sheets.
  function filterRegionsByRoom(items: PlanItemResult[], pageRoom: Map<number, string>): PlanItemResult[] {
    if (pageRoom.size === 0) return items;
    return items.map((it) => {
      const room = it.room.trim();
      if (!room || !it.regions || it.regions.length === 0) return it;
      const kept = it.regions.filter((r) => {
        const pr = pageRoom.get(r.page);
        return !pr || pr === room;
      });
      if (kept.length === it.regions.length) return it;
      if (kept.length > 0) return { ...it, regions: kept };
      const own = Array.from(pageRoom.entries()).filter(([, r]) => r === room).map(([p]) => p).slice(0, 3);
      return {
        ...it,
        regions: own.map((page) => ({ page, bbox: [0.03, 0.05, 0.97, 0.88] as [number, number, number, number] })),
      };
    });
  }

  // Curved ends: count and box them from the "R 300" callouts on the room's own sheets.
  function applyCurveMarks(
    items: PlanItemResult[],
    marks: Map<number, { x: number; y: number }[]>,
    pageRoom: Map<number, string>
  ): PlanItemResult[] {
    if (marks.size === 0) return items;
    const out: PlanItemResult[] = [];
    const done = new Set<string>();
    for (let it of items) {
      if (!/^curved end/i.test(it.name)) {
        out.push(it);
        continue;
      }
      // The curved column's width is also part of the run's lineal metres; the curve itself is its
      // own counted line (tall: priced from the book; base / wall: named so it can be priced).
      const baseWall = /^curved end\s*-\s*(base|wall)/i.exec(it.name);
      if (baseWall && !/void box/i.test(it.name)) it = { ...it, name: `Curved end - ${baseWall[1].toLowerCase()} curved void box` };
      const room = it.room.trim();
      const key = room.toLowerCase();
      const boxes: { page: number; bbox: [number, number, number, number] }[] = [];
      const ownPages = new Set((it.regions || []).map((r) => r.page));
      const roomHasPages = Array.from(pageRoom.values()).includes(room);
      marks.forEach((list, page) => {
        const pr = pageRoom.get(page);
        // Prefer the sheet's own title block; if none is tied to this room, use the AI's own pages.
        if (roomHasPages ? pr !== room : !ownPages.has(page)) return;
        list.forEach((m) => {
          const c = (n: number) => Math.min(1, Math.max(0, n));
          boxes.push({ page, bbox: [c(m.x - 0.075), c(m.y - 0.105), c(m.x + 0.095), c(m.y + 0.02)] });
        });
      });
      if (boxes.length === 0) {
        out.push(it);
        continue;
      }
      // One line per room: the number of R callouts is the number of curved ends.
      if (done.has(key)) continue;
      done.add(key);
      out.push({ ...it, qty: boxes.length, regions: boxes, note: [it.note, `${boxes.length} curved end(s) — counted from the radius callouts on the drawing`].filter(Boolean).join("; ") });
    }
    // Rooms with radius callouts on their own sheets but no curved line from the AI: add one.
    const byRoom = new Map<string, { n: number; boxes: { page: number; bbox: [number, number, number, number] }[] }>();
    marks.forEach((list, page) => {
      const room = pageRoom.get(page);
      if (!room) return;
      const e = byRoom.get(room) || { n: 0, boxes: [] };
      list.forEach((m) => {
        const c = (n: number) => Math.min(1, Math.max(0, n));
        e.n++;
        e.boxes.push({ page, bbox: [c(m.x - 0.075), c(m.y - 0.105), c(m.x + 0.095), c(m.y + 0.02)] });
      });
      byRoom.set(room, e);
    });
    byRoom.forEach((e, room) => {
      const key = room.toLowerCase();
      if (done.has(key)) return;
      const inRoom = out.filter((it) => it.room.trim().toLowerCase() === key);
      if (inRoom.length === 0 || inRoom.some((it) => /^curved end/i.test(it.name))) return;
      const tall = inRoom.some((it) => it.cabinet_type === "tall");
      const template = inRoom.find((it) => it.calc === "LM") || inRoom[0];
      out.push({
        ...template,
        name: tall ? "Curved end - tall curved void box" : "Curved end - base curved void box",
        cabinet_type: "other",
        calc: "QTY",
        qty: e.n,
        unit: "ea",
        material_hint: "",
        drawer_count: 0,
        pto_drawer_count: 0,
        drawer_brand: "",
        open: false,
        note: `${e.n} curved end(s) — counted from the radius callouts (R300) on the drawing`,
        confidence: "high",
        duplicate_wall_warning: undefined,
        regions: e.boxes,
      });
    });
    return out;
  }

  // One "Shadowline / Finger rail small job" per room, however many sheets mention it.
  function dedupeSmallJobs(items: PlanItemResult[]): PlanItemResult[] {
    const seen = new Set<string>();
    return items.filter((it) => {
      if (!/shadowline.*finger rail|finger rail.*shadowline/i.test(it.name)) return true;
      const key = it.room.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Drawers counted from the drawing's own "DRAWER" labels (elevation views only) replace the AI's
  // estimate; the box on the plan sits around the labelled drawers.
  function applyDrawerViews(items: PlanItemResult[], views: Map<number, DrawerView>, pageRoom: Map<number, string>): PlanItemResult[] {
    if (views.size === 0) return items;
    const byRoom = new Map<string, { n: number; boxes: { page: number; bbox: [number, number, number, number] }[] }>();
    views.forEach((v, page) => {
      const room = pageRoom.get(page);
      if (!room) return;
      const e = byRoom.get(room) || { n: 0, boxes: [] };
      e.n += v.count;
      e.boxes.push({ page, bbox: v.bbox });
      byRoom.set(room, e);
    });
    let out = items.slice();
    byRoom.forEach((e, room) => {
      const key = room.trim().toLowerCase();
      const inRoom = (it: PlanItemResult) => it.room.trim().toLowerCase() === key;
      const existing = out.filter((it) => inRoom(it) && /^drawers\b/i.test(it.name) && !/push-to-open/i.test(it.name));
      const brand = existing[0]?.drawer_brand || out.find((it) => inRoom(it) && it.drawer_brand)?.drawer_brand || "";
      out = out.filter((it) => !existing.includes(it));
      // A vanity the AI listed as one unit carries its own drawer count — cleared so nothing is priced twice.
      out = out.map((it) => (inRoom(it) && it.drawer_count > 0 ? { ...it, drawer_count: 0, pto_drawer_count: 0 } : it));
      const template = out.find((it) => inRoom(it) && it.calc === "LM") || out.find((it) => inRoom(it)) || blankRoomItem(out, room);
      if (!template) return;
      out.push({
        ...template,
        name: `Drawers — ${brand || "Merivo"}`,
        cabinet_type: "other",
        calc: "QTY",
        qty: e.n,
        unit: "ea",
        material_hint: "",
        drawer_count: 0,
        pto_drawer_count: 0,
        drawer_brand: brand,
        open: false,
        note: `${e.n} drawers counted from the drawing's own DRAWER labels (front / internal elevations only — plan views and side sections are not counted)`,
        confidence: "high",
        duplicate_wall_warning: undefined,
        regions: e.boxes,
      });
    });
    return out;
  }

  function applyTextCounts(
    items: PlanItemResult[],
    walls: { room?: string; name?: string; drawer_tags?: number; drawer_detail?: string; pto?: Record<string, number> }[] | undefined
  ): PlanItemResult[] {
    if (!Array.isArray(walls)) return items;
    const lm = items.filter((it) => it.calc === "LM" && ["base", "wall", "tall"].includes(it.cabinet_type));
    const rooms = Array.from(new Set(lm.map((it) => it.room.trim().toLowerCase())));
    const out = [...items];
    const roomOf = (w: { room?: string }) => {
      const r = (w.room || "").trim().toLowerCase();
      return rooms.includes(r) ? r : rooms.length === 1 ? rooms[0] : r;
    };
    const find = (room: string, type: string) =>
      out.findIndex((it) => it.calc === "LM" && it.cabinet_type === type && it.room.trim().toLowerCase() === room);
    const drawers = new Map<string, { n: number; detail: string[] }>();
    const ptoTotals = new Map<string, number>();
    for (const w of walls) {
      const room = roomOf(w);
      if ((w.drawer_tags || 0) > 0) {
        const d = drawers.get(room) || { n: 0, detail: [] };
        d.n += w.drawer_tags || 0;
        d.detail.push(`${w.name}: ${w.drawer_tags}`);
        drawers.set(room, d);
      }
      for (const [kind, n] of Object.entries(w.pto || {})) {
        if (!n) continue;
        const type = kind === "base_wall" ? "wall" : kind === "tall_wall" ? "tall" : kind;
        ptoTotals.set(room, (ptoTotals.get(room) || 0) + n);
        let idx = find(room, type);
        if (idx < 0) idx = out.findIndex((it) => it.calc === "LM" && it.room.trim().toLowerCase() === room);
        if (idx >= 0) {
          out[idx] = { ...out[idx], note: [out[idx].note, `${n}x PTO (push to open) — counted from the drawing text`].filter(Boolean).join("; ") };
        }
      }
    }
    // PTO gets its own line (like the bin or fridge) so it is priced.
    for (const [room, n] of ptoTotals) {
      const existing = out.findIndex((it) => /\bpto\b|push.to.open/i.test(it.name) && it.room.trim().toLowerCase() === room);
      if (existing >= 0) {
        out[existing] = { ...out[existing], qty: n, calc: "QTY", unit: "ea" };
        continue;
      }
      const template =
        out.find((it) => it.calc === "QTY" && it.room.trim().toLowerCase() === room) ||
        out.find((it) => it.calc === "LM" && it.room.trim().toLowerCase() === room);
      if (template) {
        out.push({
          ...template,
          name: "Push-to-open (PTO) doors",
          cabinet_type: "other",
          calc: "QTY",
          qty: n,
          unit: "ea",
          material_hint: "",
          drawer_count: 0,
          pto_drawer_count: 0,
          drawer_brand: "",
          open: false,
          note: `${n}x PTO (push to open) — counted from the drawing text`,
          confidence: "high",
          duplicate_wall_warning: undefined,
          regions: [],
        });
      }
    }
    for (const [room, d] of drawers) {
      const idx = find(room, "base");
      if (idx >= 0) {
        out[idx] = {
          ...out[idx],
          drawer_count: d.n,
          note: [out[idx].note, `${d.n} drawers counted from the drawing text (${d.detail.join("; ")})`].filter(Boolean).join("; "),
        };
      }
    }
    return out;
  }

  // Lets the estimator correct a column's type (e.g. a full-height shelving
  // unit the AI called base+wall) and recomputes the base / wall / tall
  // lengths from the widths — the widths themselves are never editable.
  function setColumnKind(wi: number, ci: number, kind: string) {
    setPlanResult((prev) => {
      if (!prev || !prev.column_report || !prev.column_base) return prev;
      const walls = prev.column_report.map((w, i) => ({
        room: w.room,
        name: w.name,
        page: w.page,
        overall_mm: w.overall,
        geom: w.geom,
        columns: w.columns.map((c, j) => (i === wi && j === ci ? { ...c, kind } : c)),
      }));
      const inv = applyColumnInventory(prev.column_base.items, walls);
      return {
        ...prev,
        items: anchorRegions(flagMatchingBandLengths(inv.items), inv.report),
        column_report: inv.report,
        column_warnings: inv.warnings,
      };
    });
  }

  async function runPlanRead(planFile: File, scheduleFile: File | null) {
    setPlanUploading(true);
    setPlanError(null);
    setPlanResult(null);
    setPlanItemMaterial({});
    setPlanItemFlag({});
    setExpandedPlanItems(new Set());
    setRemovedPlanItems(new Set());
    // Kept so the "View on plan" preview (below) can re-render the actual
    // page later and draw the AI's reported region on it — the server
    // deletes its copy of the upload right after reading it, so this is the
    // only copy left once the read comes back.
    setLastPlanFile(planFile);

    // Checked here, before anything is uploaded, because this is the one
    // call site every upload path goes through (direct or via the page
    // picker) — catches the Anthropic request-size limit regardless of how
    // the files got here, rather than finding out from a 413 afterwards.
    const estimatedRequestBytes = estimateBase64Size(planFile.size) + estimateBase64Size(scheduleFile?.size ?? 0);
    const isPdfUpload = planFile.type === "application/pdf" || /\.pdf$/i.test(planFile.name);
    if (!isPdfUpload && estimatedRequestBytes > ANTHROPIC_REQUEST_LIMIT_BYTES) {
      setPlanUploading(false);
      setPlanError(
        `This would send about ${(estimatedRequestBytes / (1024 * 1024)).toFixed(1)}MB to the AI once encoded — over its ~32MB request limit. Select fewer pages${
          scheduleFile ? ", or a smaller finishes schedule," : ""
        } and try again.`
      );
      return;
    }

    try {
      const supabase = createBrowserClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        setPlanError("Your session has expired — please log in again.");
        return;
      }

      // Big drawing sets are read in chunks of PAGES_PER_READ pages (a few at a
      // time in parallel), then the results are combined — one request can't
      // hold a whole house worth of rooms.
      let pageTotal = 1;
      const isPdfFile = planFile.type === "application/pdf" || /\.pdf$/i.test(planFile.name);
      if (isPdfFile) {
        try {
          pageTotal = (await PDFDocument.load(await planFile.arrayBuffer())).getPageCount();
        } catch {
          pageTotal = 1;
        }
      }
      const chunks: number[][] = [];
      if (pageTotal > PAGES_PER_READ) {
        for (let i = 0; i < pageTotal; i += PAGES_PER_READ) {
          chunks.push(Array.from({ length: Math.min(PAGES_PER_READ, pageTotal - i) }, (_, k) => i + k));
        }
      } else {
        chunks.push([]);
      }

      async function readChunk(indices: number[]): Promise<{ data?: any; error?: string }> {
        const chunkFile = indices.length > 0 ? await extractPdfPages(planFile, indices) : planFile;
        const planPath = storagePathFor(user!.id, chunkFile);
        const { error: planUploadError } = await supabase.storage
          .from("plan-uploads")
          .upload(planPath, chunkFile, { contentType: chunkFile.type });
        if (planUploadError) return { error: "Could not upload the plan. Please try again." };

        let schedulePath: string | null = null;
        if (scheduleFile) {
          schedulePath = storagePathFor(user!.id, scheduleFile);
          const { error: scheduleUploadError } = await supabase.storage
            .from("plan-uploads")
            .upload(schedulePath, scheduleFile, { contentType: scheduleFile.type });
          if (scheduleUploadError) return { error: "Could not upload the finishes schedule. Please try again." };
        }

        const dim = await extractDimensionStrings(chunkFile);
        const res = await fetch("/api/plans/read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ planPath, schedulePath, dimensionStrings: dim.strings, dimNote: dim.note }),
        });
        const rawBody = await res.text();
        let d: any;
        try {
          d = JSON.parse(rawBody);
        } catch {
          return {
            error: `The server stopped before finishing the read (status ${res.status}) — usually a time-out on a large or busy read. ${rawBody.slice(0, 80).replace(/<[^>]*>/g, " ").trim()}`,
          };
        }
        if (!res.ok) return { error: d.error || "Could not read this plan." };
        // Page numbers in this chunk are relative to the chunk — shift them back to the whole file.
        const off = indices.length > 0 ? indices[0] : 0;
        if (off > 0) {
          (d.items || []).forEach((it: any) => (it.regions || []).forEach((r: any) => { if (typeof r.page === "number") r.page += off; }));
          (d.walls || []).forEach((w: any) => {
            if (typeof w.page === "number") w.page += off;
            if (w.geom && typeof w.geom.page === "number") w.geom.page += off;
          });
        }
        return { data: d };
      }

      const results: ({ data?: any; error?: string } | undefined)[] = new Array(chunks.length);
      let nextChunk = 0;
      let doneChunks = 0;
      const updateProgress = () => {
        if (chunks.length > 1) setPlanProgress(`Reading plan… part ${Math.min(doneChunks + 1, chunks.length)} of ${chunks.length}`);
      };
      updateProgress();
      const workers = Array.from({ length: Math.min(3, chunks.length) }, async () => {
        while (nextChunk < chunks.length) {
          const ci = nextChunk++;
          try {
            results[ci] = await readChunk(chunks[ci]);
          } catch (e) {
            results[ci] = { error: e instanceof Error ? e.message : String(e) };
          }
          doneChunks++;
          updateProgress();
        }
      });
      await Promise.all(workers);

      const okResults = results.filter((r) => r?.data).map((r) => r!.data);
      const failed = results.map((r, i) => (r?.error ? `pages ${chunks[i][0] + 1}–${chunks[i][chunks[i].length - 1] + 1}: ${r.error}` : "")).filter(Boolean);
      if (okResults.length === 0) {
        setPlanError(failed[0] || "Could not read this plan.");
        return;
      }
      const data: any = { ...okResults[0] };
      okResults.slice(1).forEach((d) => {
        Object.keys(d).forEach((k) => {
          if (Array.isArray(d[k])) data[k] = [...(Array.isArray(data[k]) ? data[k] : []), ...d[k]];
          else if (data[k] === undefined || data[k] === null || data[k] === "") data[k] = d[k];
        });
      });
      if (failed.length > 0) {
        data.consistency_warnings = [
          ...(data.consistency_warnings || []),
          ...failed.map((f) => `Part of the plan could not be read and is missing from this list — ${f}`),
        ];
      }

      // Fold any duplicate run filed under two different room labels back
      // onto one label (see reconcileRoomLabels), then combine matching
      // base/wall/tall bands from different walls — see mergePlanBands for
      // why that's done in code rather than asking the model to do the
      // cross-wall arithmetic itself.
      let roomLabels: string[] = [];
      if (Array.isArray(data.items)) {
        const reconciled = reconcileRoomLabels(data.items as PlanItemResult[]);
        roomLabels = reconciled.roomLabels;
        const pageTitles = await extractPageTitles(planFile);
        if (pageTitles.size === 0 && pageTotal > 1) {
          data.consistency_warnings = [...(data.consistency_warnings || []), "Could not read the sheet titles from this PDF, so rooms were matched from the AI's own page guesses — check each room's lengths and drawers."];
        }
        const pageRoom = roomsByPageTitle(reconciled.items, pageTitles);
        assignWallRooms(reconciled.items, data.walls, pageRoom, pageTitles);
        reconciled.items = filterRegionsByRoom(reconciled.items, pageRoom);
        reconciled.items = dedupeSmallJobs(applyCurveMarks(reconciled.items, await extractRadiusMarks(planFile), pageRoom));
        const merged = applyDrawerViews(
          splitDrawersOut(applyTextCounts(mergePlanBands(reconciled.items), data.walls)),
          await extractDrawerViews(planFile),
          pageRoom
        );
        const inv = applyColumnInventory(merged, data.walls);
        data.items = addStandardDelivery(anchorRegions(flagMatchingBandLengths(inv.items), inv.report));
        data.column_report = inv.report;
        data.column_base = { items: merged };
        data.column_warnings = inv.warnings;
      }
      // If more than one room label survives reconciliation, this wasn't a
      // clean single-room read — tell the estimator so they check the Room
      // field on each item (editable below) before adding to the quote,
      // rather than silently exporting a document split into sections that
      // may really be the one room under two different names.
      data.room_label_warning =
        roomLabels.length > 1
          ? `This read used more than one room name (${roomLabels
              .map((r) => `"${r}"`)
              .join(
                ", "
              )}) — if this plan is really just one room, check and correct the Room field on the items below before adding them, so they don't end up split across separate sections on the quote.`
          : undefined;
      setPlanResult(data);
      // Only fill these in when the estimator hasn't already typed something
      // — the plan is a convenience, not an override of what's already on
      // the quote.
      if (data.client_name && !clientName.trim()) setClientName(data.client_name);
      if (data.job_address && !jobAddress.trim()) setJobAddress(data.job_address);
      // Default the active area to this plan's own room too, so a manual
      // price-book add made after this read (an end panel the model missed,
      // say) lands in the same section as everything else from this plan
      // instead of defaulting into a separate "General" one.
      if (activeArea === "General") {
        const roomCounts = new Map<string, number>();
        (data.items as PlanItemResult[]).forEach((it) => {
          const room = it.room?.trim();
          if (room && room !== "General") roomCounts.set(room, (roomCounts.get(room) || 0) + 1);
        });
        let topRoom: string | null = null;
        roomCounts.forEach((count, room) => {
          if (!topRoom || count > (roomCounts.get(topRoom) || 0)) topRoom = room;
        });
        if (topRoom) setActiveArea(topRoom);
      }
      setSelectedPlanItems(new Set(data.items.map((_: unknown, i: number) => i)));
      const defaults: Record<number, string> = {};
      const flags: Record<number, string> = {};
      (data.items as PlanItemResult[]).forEach((it, i) => {
        if (isNoPriceScopeItem(it)) {
          flags[i] = "Joinery scope only — no price needed (supplied/installed by others).";
          return;
        }
        const options = materialOptionsFor(it);
        const defaultMatch = defaultAccessoryMatch(it);
        const { match, exact } = defaultMatch
          ? { match: defaultMatch, exact: true }
          : bestMaterialMatch(options, `${it.name} ${it.material_hint}`);
        if (match) defaults[i] = match.id;
        flags[i] = buildMaterialFlag(it, options, match, exact);
      });
      setPlanItemMaterial(defaults);
      setPlanItemFlag(flags);
    } catch (err) {
      console.error("Plan read failed:", err);
      const detail = err instanceof Error ? err.message : String(err);
      setPlanError(`The plan could not be read (${detail.slice(0, 160)}). If this keeps happening, tell Claude the exact message.`);
    } finally {
      setPlanUploading(false);
      setPlanProgress("");
    }
  }

  async function openPdfPicker(target: "plan" | "schedule", file: File) {
    setPlanError(null);
    let pageCount: number;
    try {
      const srcDoc = await PDFDocument.load(await file.arrayBuffer());
      pageCount = srcDoc.getPageCount();
    } catch {
      setPlanError("Could not open this PDF to select pages. Please try again.");
      return;
    }

    setPdfPicker({
      target,
      file,
      pageCount,
      // Big drawing sets: start with nothing selected so the whole house isn't read at once.
      selectedPages: allPageIndices(pageCount),
      pagesInput: "",
      thumbnails: new Array(pageCount).fill(""),
      busy: false,
      error: null,
    });

    // Renders in the background and fills the grid in as each page is
    // ready — a 60+ page CD set can take a while, so there's no point
    // blocking the picker on it.
    renderPdfThumbnails(file, (index, dataUrl) => {
      setPdfPicker((prev) => {
        if (!prev || prev.file !== file) return prev;
        const thumbnails = [...prev.thumbnails];
        thumbnails[index] = dataUrl;
        return { ...prev, thumbnails };
      });
    }).catch(() => {
      // Previews are a convenience, not a requirement — the page-number
      // text field still works even if rendering them fails.
    });
  }

  async function pdfPageCountOver(file: File, n: number) {
    try {
      const d = await PDFDocument.load(await file.arrayBuffer());
      return d.getPageCount() > n;
    } catch {
      return false;
    }
  }

  async function handlePlanUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    if (file.type === "application/pdf" && (file.size > PDF_PICKER_THRESHOLD_BYTES || (await pdfPageCountOver(file, 8)))) {
      openPdfPicker("plan", file);
      return;
    }

    runPlanRead(file, scheduleFileRef.current);
  }

  async function handleScheduleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] || null;
    e.target.value = "";
    if (!file) {
      scheduleFileRef.current = null;
      setScheduleFileName(null);
      return;
    }

    if (file.type === "application/pdf" && file.size > PDF_PICKER_THRESHOLD_BYTES) {
      openPdfPicker("schedule", file);
      return;
    }

    scheduleFileRef.current = file;
    setScheduleFileName(file.name);
  }

  function togglePickerPage(index: number) {
    setPdfPicker((prev) => {
      if (!prev) return prev;
      const selectedPages = new Set(prev.selectedPages);
      if (selectedPages.has(index)) selectedPages.delete(index);
      else selectedPages.add(index);
      return { ...prev, selectedPages, pagesInput: serializePageSpec(selectedPages, prev.pageCount), error: null };
    });
  }

  function setPickerPagesInput(value: string) {
    setPdfPicker((prev) => {
      if (!prev) return prev;
      const selectedPages =
        value.trim() === "" ? allPageIndices(prev.pageCount) : new Set(parsePageSpec(value, prev.pageCount));
      return { ...prev, pagesInput: value, selectedPages, error: null };
    });
  }

  function selectAllPickerPages() {
    setPdfPicker((prev) => (prev ? { ...prev, selectedPages: allPageIndices(prev.pageCount), pagesInput: "", error: null } : prev));
  }

  function selectNonePickerPages() {
    setPdfPicker((prev) => (prev ? { ...prev, selectedPages: new Set(), pagesInput: "", error: null } : prev));
  }

  async function confirmPdfPicker() {
    if (!pdfPicker) return;
    if (pdfPicker.selectedPages.size === 0) {
      setPdfPicker((prev) => (prev ? { ...prev, error: "Select at least one page." } : prev));
      return;
    }
    setPdfPicker((prev) => (prev ? { ...prev, busy: true, error: null } : prev));
    try {
      const indices = Array.from(pdfPicker.selectedPages).sort((a, b) => a - b);
      const extracted = await extractPdfPages(pdfPicker.file, indices);
      if (extracted.size > UPLOAD_HARD_LIMIT_BYTES) {
        setPdfPicker((prev) =>
          prev
            ? {
                ...prev,
                busy: false,
                error: `Still too large (${(extracted.size / (1024 * 1024)).toFixed(1)}MB) even after selecting pages. Try selecting fewer pages.`,
              }
            : prev
        );
        return;
      }

      if (pdfPicker.target === "plan") {
        setPdfPicker(null);
        runPlanRead(extracted, scheduleFileRef.current);
      } else {
        scheduleFileRef.current = extracted;
        setScheduleFileName(extracted.name);
        setPdfPicker(null);
      }
    } catch {
      setPdfPicker((prev) =>
        prev ? { ...prev, busy: false, error: "Could not extract those pages. Check the page numbers and try again." } : prev
      );
    }
  }

  function cancelPdfPicker() {
    setPdfPicker(null);
  }

  // The AI read gets an estimator very close on a tricky multi-wall plan,
  // but a vision read of a complex drawing will occasionally land a few
  // percent off on one wall's length or drawer count — letting the
  // estimator fix that number here, in five seconds, beats chasing it
  // through another re-upload (or trusting a number that's slightly off).
  function updatePlanItem(i: number, patch: Partial<PlanItemResult>) {
    setPlanResult((prev) => {
      if (!prev) return prev;
      const items = prev.items.slice();
      items[i] = { ...items[i], ...patch };
      return { ...prev, items };
    });
  }

  function addSelectedPlanItems() {
    if (!planResult) return;
    const toAdd = planResult.items
      .map((it, i) => ({ it, i }))
      .filter(({ i }) => selectedPlanItems.has(i));

    // A job-wide item (the combined "by others" exclusion line, or anything
    // else the model couldn't tie to one room) comes back with room
    // "General" or blank — which used to land it in its own separate
    // "General" section on the quote, away from the room it actually
    // belongs with. When this plan read is really just one room's worth of
    // items (the normal case — one plan read, one room), fall back to that
    // room instead, so every item added from this read lands in the same
    // section rather than splitting off a stray "General" heading. This is
    // worked out from the WHOLE read (planResult.items), not just the items
    // selected in this particular click — the estimator may add a plan's
    // items in more than one batch (e.g. cabinetry first, end panels after),
    // and each batch should still land in the same room.
    const roomCounts = new Map<string, number>();
    planResult.items.forEach((it) => {
      const room = it.room?.trim();
      if (room && room !== "General") roomCounts.set(room, (roomCounts.get(room) || 0) + 1);
    });
    let dominantRoom: string | null = null;
    roomCounts.forEach((count, room) => {
      if (!dominantRoom || count > (roomCounts.get(dominantRoom) || 0)) dominantRoom = room;
    });
    const areaFor = (it: PlanItemResult) => {
      const room = it.room?.trim();
      return room && room !== "General" ? room : dominantRoom || "General";
    };

    const newLines: LineItem[] = [];
    toAdd.forEach(({ it, i }) => {
      const noPrice = isNoPriceScopeItem(it);
      const chosenId = planItemMaterial[i];
      const chosen = !noPrice && chosenId ? priceBook.find((p) => p.id === chosenId) : null;
      // Default-matched accessories (hamper, LED, hanging rod — see
      // defaultAccessoryMatch) already have an unambiguous, plain-English
      // name; dumping the price book's own wording into the note just
      // duplicates it with clunkier phrasing ("1x hanging rail in laundry").
      // Reserve the note for cases where the match itself is informative —
      // a cabinet run's chosen finish, or a fuzzy-matched item where it's
      // worth confirming exactly which price-book line was picked.
      const isDefaultMatch = !noPrice && defaultAccessoryMatch(it) !== null;

      newLines.push({
        key: newKey(),
        price_book_item_id: chosen?.id ?? null,
        name: it.name,
        category: noPrice ? "Joinery scope (no price)" : chosen?.category ?? "From plan",
        calc: it.calc,
        unit: chosen?.unit ?? it.unit,
        rate: chosen ? Number(chosen.rate) : 0,
        qty: it.qty,
        area: areaFor(it),
        note: chosen && !isDefaultMatch ? chosen.name : "",
        pdf_label: it.name,
        poa: noPrice,
        flag_label: planItemFlag[i] ?? "",
      });

      if (it.drawer_count > 0) {
        const ptoCount = Math.min(it.pto_drawer_count || 0, it.drawer_count);
        const standardCount = it.drawer_count - ptoCount;
        // A base-run drawer bank doesn't need "For: Base cabinet run"
        // restating the obvious — only the tall case is worth flagging,
        // since that's the detail an installer needs at a glance.
        const tallNote = it.cabinet_type === "tall" ? "TALL" : "";

        if (standardCount > 0) {
          const hardware = findDrawerHardware(it.drawer_brand, false);
          newLines.push({
            key: newKey(),
            price_book_item_id: hardware?.id ?? null,
            name: hardware ? hardware.name : `Drawers — ${it.drawer_brand || "Merivo"} (not in price book)`,
            category: "Hardware",
            calc: "QTY",
            unit: hardware?.unit ?? "ea",
            rate: hardware ? Number(hardware.rate) : 0,
            qty: standardCount,
            area: areaFor(it),
            note: tallNote,
            pdf_label: "",
            poa: false,
            flag_label: hardware ? "" : "Select drawer hardware",
          });
        }
        if (ptoCount > 0) {
          const ptoHardware = findDrawerHardware(it.drawer_brand, true);
          newLines.push({
            key: newKey(),
            price_book_item_id: ptoHardware?.id ?? null,
            name: ptoHardware
              ? `${ptoHardware.name} (Push to Open)`
              : `Drawers — ${it.drawer_brand || "Merivo"} Push to Open (not in price book)`,
            category: "Hardware",
            calc: "QTY",
            unit: ptoHardware?.unit ?? "ea",
            rate: ptoHardware ? Number(ptoHardware.rate) : 0,
            qty: ptoCount,
            area: areaFor(it),
            note: tallNote,
            pdf_label: "",
            poa: false,
            flag_label: ptoHardware ? "" : "Select drawer hardware",
          });
        }
      }
    });

    setLineItems((prev) => [...prev, ...newLines]);
    setPlanResult(null);
    setPlanItemMaterial({});
    setPlanItemFlag({});
  }

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return priceBook
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q) ||
          p.section.toLowerCase().includes(q)
      )
      .slice(0, 25);
  }, [search, priceBook]);

  const areas = useMemo(() => {
    const set = new Set<string>();
    lineItems.forEach((it) => set.add(it.area || "General"));
    set.add(activeArea);
    return Array.from(set);
  }, [lineItems, activeArea]);

  const subtotal = useMemo(
    () => lineItems.reduce((sum, it) => (it.poa ? sum : sum + it.qty * it.rate), 0),
    [lineItems]
  );
  const markupAmount = subtotal * (markupPct / 100);
  const total = subtotal + markupAmount;
  const hasPoaItems = lineItems.some((it) => it.poa);

  function addFromPriceBook(pb: PriceBookItem) {
    setLineItems((prev) => [
      ...prev,
      {
        key: newKey(),
        price_book_item_id: pb.id,
        name: pb.name,
        category: pb.category,
        calc: pb.calc,
        unit: pb.unit,
        rate: Number(pb.rate),
        qty: 1,
        area: activeArea,
        note: "",
        pdf_label: "",
        poa: false,
        flag_label: "",
      },
    ]);
    setSearch("");
  }

  function addCustomItem() {
    setLineItems((prev) => [
      ...prev,
      {
        key: newKey(),
        price_book_item_id: null,
        name: "Custom item",
        category: "Custom",
        calc: "MISC",
        unit: "item",
        rate: 0,
        qty: 1,
        area: activeArea,
        note: "",
        pdf_label: "",
        poa: false,
        flag_label: "",
      },
    ]);
  }

  function updateItem(key: string, patch: Partial<LineItem>) {
    setLineItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }

  function removeItem(key: string) {
    setLineItems((prev) => prev.filter((it) => it.key !== key));
  }

  function handleSave() {
    setSaveError(null);
    setSavedNotice(false);

    const meta: QuoteMetaInput = {
      business_name: businessName,
      business_contact: businessContact,
      builder_name: builderName,
      client_name: clientName,
      job_address: jobAddress,
      quote_ref: quoteRef,
      quote_date: quoteDate,
      valid_days: Number(validDays) || 0,
      markup_pct: Number(markupPct) || 0,
      notes,
    };

    const itemInputs: QuoteItemInput[] = lineItems.map((it, index) => ({
      price_book_item_id: it.price_book_item_id,
      name: it.name,
      category: it.category,
      calc: it.calc,
      unit: it.unit,
      rate: it.rate,
      qty: it.qty,
      area: it.area,
      note: it.note,
      pdf_label: it.pdf_label,
      poa: it.poa,
      flag_label: it.flag_label,
      sort_order: index,
    }));

    startTransition(async () => {
      const result = await saveQuote(quote?.id ?? null, meta, itemInputs, total);
      if ("error" in result) {
        setSaveError(result.error);
        return;
      }
      setSavedNotice(true);
      if (!quote?.id) {
        router.push(`/dashboard/quotes/${result.id}`);
      } else {
        router.refresh();
      }
    });
  }

  function buildExportData() {
    return {
      businessName,
      businessContact,
      builderName,
      clientName,
      jobAddress,
      quoteRef,
      quoteDate,
      validDays: Number(validDays) || 0,
      markupPct: Number(markupPct) || 0,
      notes,
      items: lineItems.map((it) => ({
        // The quote shows what the client should see on paper — the
        // original drawing wording when the estimator has set one,
        // otherwise the internal item name.
        name: it.pdf_label || it.name,
        category: it.category,
        unit: it.unit,
        rate: it.rate,
        qty: it.qty,
        area: it.area,
        note: it.note,
        poa: it.poa,
      })),
      subtotal,
      markupAmount,
      total,
    };
  }

  // Plan items that were read but not yet added to the quote would be
  // missing from the export, so check before exporting.
  function confirmExport() {
    if (planResult && selectedPlanItems.size > 0) {
      return window.confirm(
        `${selectedPlanItems.size} item(s) read from the plan haven't been added to the quote yet, so they won't be in this export.\n\nPress Cancel, click "Add selected to quote", then export again.\n\nPress OK to export without them.`
      );
    }
    return true;
  }

  function handleExportPdf() {
    if (!confirmExport()) return;
    downloadQuotePdf(buildExportData(), `${quoteRef || "quote"}.pdf`);
  }

  function handleExportDocx() {
    if (!confirmExport()) return;
    downloadQuoteDocx(buildExportData(), `${quoteRef || "quote"}.docx`);
  }

  function handleDelete() {
    if (!quote?.id) return;
    if (!window.confirm("Delete this quote? This cannot be undone.")) return;
    startTransition(async () => {
      await deleteQuoteAndRedirect(quote.id);
    });
  }

  // Clears everything on screen so the estimator can start a fresh quote.
  // This never touches what's saved in the database — if this was an
  // existing saved quote, it just navigates to a blank "New quote" page
  // (so a later Save creates a new quote instead of overwriting this one);
  // if it was already a blank new-quote page, it resets the form in place.
  function handleStartNew() {
    const hasContent =
      lineItems.length > 0 || clientName || jobAddress || quoteRef || notes || planResult;
    if (hasContent) {
      const ok = window.confirm("Clear this quote and start a new one? Anything unsaved will be lost.");
      if (!ok) return;
    }
    if (quote?.id) {
      router.push("/dashboard/quotes/new");
      return;
    }
    setClientName("");
    setJobAddress("");
    setQuoteRef("");
    setQuoteDate(new Date().toISOString().slice(0, 10));
    setValidDays(30);
    setMarkupPct(32);
    setNotes("");
    setBuilderName(defaultBuilderName);
    setLineItems([]);
    setSearch("");
    setActiveArea("General");
    setPlanResult(null);
    setSelectedPlanItems(new Set());
    setPlanItemMaterial({});
    setPlanItemFlag({});
    setScheduleFileName(null);
    setLastPlanFile(null);
    setRegionPreview(null);
    setOverview(null);
    setPlanError(null);
    setSaveError(null);
    setSavedNotice(false);
  }

  return (
    <div className="max-w-5xl mx-auto pb-16">
      <div className="flex items-center justify-between mb-5">
        <h2 className="font-display text-xl font-semibold">
          {quote ? "Edit quote" : "New quote"}
        </h2>
        <div className="flex items-center gap-3">
          {savedNotice && <span className="text-xs text-spruce">Saved</span>}
          {saveError && <span className="text-xs text-brick">{saveError}</span>}
          <button
            onClick={handleStartNew}
            className="text-xs border border-line-strong rounded-md px-3 py-1.5 hover:bg-paper"
            title="Clear this quote and start a new one (doesn't delete anything already saved)"
          >
            ↻ Start new quote
          </button>
          <button
            onClick={handleExportPdf}
            disabled={lineItems.length === 0}
            className="text-xs border border-line-strong rounded-md px-3 py-1.5 hover:bg-paper disabled:opacity-40"
          >
            Export PDF
          </button>
          <button
            onClick={handleExportDocx}
            disabled={lineItems.length === 0}
            className="text-xs border border-line-strong rounded-md px-3 py-1.5 hover:bg-paper disabled:opacity-40"
          >
            Export Word
          </button>
          {quote && (
            <button
              onClick={handleDelete}
              disabled={isPending}
              className="text-xs text-brick underline disabled:opacity-50"
            >
              Delete
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={isPending}
            className="bg-brass hover:bg-brass-deep text-white rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {isPending ? "Saving…" : "Save quote"}
          </button>
        </div>
      </div>

      {/* Job details */}
      <section className="bg-paper-raised border border-line-strong rounded-lg p-5 mb-5">
        <h3 className="font-display text-sm font-semibold mb-3 text-ink-soft uppercase tracking-wide">
          Job details
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Field label="Client name">
            <input className="input" value={clientName} onChange={(e) => setClientName(e.target.value)} />
          </Field>
          <Field label="Job address">
            <input className="input" value={jobAddress} onChange={(e) => setJobAddress(e.target.value)} />
          </Field>
          <Field label="Quote ref">
            <input className="input" value={quoteRef} onChange={(e) => setQuoteRef(e.target.value)} />
          </Field>
          <Field label="Quote date">
            <input
              type="date"
              className="input"
              value={quoteDate}
              onChange={(e) => setQuoteDate(e.target.value)}
            />
          </Field>
          <Field label="Valid for (days)">
            <input
              type="number"
              className="input"
              value={validDays}
              onChange={(e) => setValidDays(Number(e.target.value))}
            />
          </Field>
          <Field label="Builder / contact name">
            <input className="input" value={builderName} onChange={(e) => setBuilderName(e.target.value)} />
          </Field>
        </div>
      </section>

      {/* Price book search */}
      <section className="bg-paper-raised border border-line-strong rounded-lg p-5 mb-5">
        <h3 className="font-display text-sm font-semibold mb-3 text-ink-soft uppercase tracking-wide">
          Add items
        </h3>
        <div className="flex flex-wrap gap-3 mb-3">
          <input
            className="input flex-1 min-w-[200px]"
            placeholder="Search your price book…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <input
            className="input w-44 shrink-0"
            placeholder="Room / area"
            value={activeArea}
            onChange={(e) => setActiveArea(e.target.value || "General")}
          />
          <button
            onClick={addCustomItem}
            className="whitespace-nowrap shrink-0 border border-line-strong rounded-md px-3 py-2 text-sm hover:bg-paper"
          >
            + Custom item
          </button>
        </div>
        {searchResults.length > 0 && (
          <div className="border border-line rounded-md divide-y divide-line max-h-72 overflow-y-auto">
            {searchResults.map((pb) => (
              <button
                key={pb.id}
                onClick={() => addFromPriceBook(pb)}
                className="w-full text-left px-3 py-2 text-sm hover:bg-paper flex items-center justify-between gap-3"
              >
                <span>
                  <span className="font-medium">{pb.name}</span>
                  <span className="text-ink-soft"> — {pb.category}</span>
                </span>
                <span className="font-mono text-xs whitespace-nowrap">
                  ${money(Number(pb.rate))} / {pb.unit}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Read a plan */}
      <section className="bg-paper-raised border border-line-strong rounded-lg p-5 mb-5">
        <h3 className="font-display text-sm font-semibold mb-3 text-ink-soft uppercase tracking-wide">
          Read a plan
        </h3>
        <div className="flex flex-wrap gap-2 items-center">
          <label className="inline-block border border-line-strong rounded-md px-3 py-2 text-sm cursor-pointer hover:bg-paper">
            {planUploading ? (planProgress || "Reading plan…") : "Upload a plan (PNG, JPEG or PDF)"}
            <input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" className="hidden" onChange={handlePlanUpload} disabled={planUploading} />
          </label>
          <label className="inline-block border border-line rounded-md px-3 py-2 text-xs cursor-pointer hover:bg-paper text-ink-soft">
            {scheduleFileName ? `Schedule: ${scheduleFileName}` : "+ Attach finishes/hardware schedule (optional)"}
            <input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" className="hidden" onChange={handleScheduleUpload} disabled={planUploading} />
          </label>
        </div>
        {planError && <p className="text-brick text-sm mt-2">{planError}</p>}

        {pdfPicker && (
          <div className="mt-4 border border-line-strong rounded-md p-4 bg-paper">
            <p className="text-sm font-medium mb-1">
              This {pdfPicker.target === "plan" ? "plan" : "schedule"} PDF is large ({(pdfPicker.file.size / (1024 * 1024)).toFixed(1)}MB,{" "}
              {pdfPicker.pageCount} pages).
            </p>
            <p className="text-xs text-ink-soft mb-3">
              Click the sheets you need below, or type page numbers (e.g. "4, 7, 12-14"). All pages are selected by
              default — click a thumbnail to drop it, or start from none and add just what you need.
            </p>

            <div className="flex flex-wrap gap-2 items-center mb-3">
              <button
                onClick={selectAllPickerPages}
                disabled={pdfPicker.busy}
                className="shrink-0 border border-line-strong rounded-md px-2.5 py-1 text-xs hover:bg-white disabled:opacity-50"
              >
                Select all
              </button>
              <button
                onClick={selectNonePickerPages}
                disabled={pdfPicker.busy}
                className="shrink-0 border border-line-strong rounded-md px-2.5 py-1 text-xs hover:bg-white disabled:opacity-50"
              >
                Select none
              </button>
              <span className="text-xs text-ink-soft">
                {pdfPicker.selectedPages.size} of {pdfPicker.pageCount} pages selected
              </span>
            </div>

            <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2 max-h-96 overflow-y-auto border border-line rounded-md p-2 mb-3 bg-white">
              {Array.from({ length: pdfPicker.pageCount }).map((_, i) => {
                const isSelected = pdfPicker.selectedPages.has(i);
                const thumb = pdfPicker.thumbnails[i];
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => togglePickerPage(i)}
                    disabled={pdfPicker.busy}
                    className={`relative rounded border overflow-hidden text-left disabled:opacity-50 ${
                      isSelected ? "border-ink ring-2 ring-ink" : "border-line opacity-50 hover:opacity-80"
                    }`}
                    title={`Page ${i + 1}`}
                  >
                    {thumb ? (
                      // Low-res client-rendered previews, not user content requiring alt text beyond the page number.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={thumb} alt={`Page ${i + 1}`} className="w-full h-auto block" />
                    ) : (
                      <div className="aspect-[3/4] flex items-center justify-center text-[10px] text-ink-soft bg-paper">
                        Loading…
                      </div>
                    )}
                    <span className="absolute bottom-0.5 right-0.5 bg-ink text-paper text-[10px] leading-none px-1 py-0.5 rounded-sm">
                      {i + 1}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap gap-2 items-center">
              <input
                type="text"
                className="input min-w-[200px] flex-1"
                placeholder={`Page numbers (1–${pdfPicker.pageCount})`}
                value={pdfPicker.pagesInput}
                onChange={(e) => setPickerPagesInput(e.target.value)}
                disabled={pdfPicker.busy}
              />
              <button
                onClick={confirmPdfPicker}
                disabled={pdfPicker.busy}
                className="shrink-0 bg-ink text-paper rounded-md px-3 py-2 text-sm hover:opacity-90 disabled:opacity-50"
              >
                {pdfPicker.busy ? "Extracting…" : "Use these pages"}
              </button>
              <button
                onClick={cancelPdfPicker}
                disabled={pdfPicker.busy}
                className="shrink-0 border border-line-strong rounded-md px-3 py-2 text-sm hover:bg-paper disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
            {pdfPicker.error && <p className="text-brick text-sm mt-2">{pdfPicker.error}</p>}
          </div>
        )}

        {planResult && (
          <div className="mt-4">
            {planResult.room_label_warning && (
              <div className="bg-amber-50 border border-amber-300 rounded-md p-3 mb-3 text-xs text-amber-900">
                ⚠ {planResult.room_label_warning}
              </div>
            )}
            {planResult.column_warnings && planResult.column_warnings.length > 0 && (
              <details className="bg-amber-50 border border-amber-300 rounded-md p-3 mb-3 text-xs text-amber-900">
                <summary className="cursor-pointer font-medium">
                  {planResult.column_warnings.length} column check{planResult.column_warnings.length === 1 ? "" : "s"} (click to review)
                </summary>
                <ul className="list-disc pl-4 mt-1 space-y-0.5">
                  {planResult.column_warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </details>
            )}
            {planResult.column_report && planResult.column_report.length > 0 && (
              <details className="border border-line rounded-md p-3 mb-3 text-xs">
                <summary className="cursor-pointer font-medium">
                  Column breakdown — how base / wall / tall lengths were added up (you can correct a column's type here)
                </summary>
                <p className="mt-2 text-ink-soft">
                  Widths from:{" "}
                  {planResult.column_source === "pdf_text"
                    ? "the PDF's own text (exact)"
                    : "the AI's reading of the picture (less reliable)"}
                  {planResult.dim_note ? ` — ${planResult.dim_note}` : ""}
                </p>
                <div className="mt-3 space-y-4">
                  {planResult.column_report.map((w, wi) => (
                    <div key={wi} className="rounded border border-line">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 bg-paper px-3 py-1.5">
                        <p className="font-medium">
                          {w.room ? `${w.room} · ` : ""}
                          {w.name.replace(/\s*\(page \d+,\s*\d+mm\)/i, "")} · page {w.page}
                        </p>
                        <p className={w.ok ? "text-ink-soft" : "text-red-700"}>
                          {w.ok ? `✓ ${w.sum}mm matches the printed overall` : `⚠ columns add to ${w.sum}mm, printed overall ${w.overall || "—"}mm`}
                        </p>
                      </div>
                      <table className="w-full table-fixed">
                        <colgroup>
                          <col className="w-16" />
                          <col className="w-48" />
                          <col />
                        </colgroup>
                        <tbody>
                          {w.columns.map((c, ci) => (
                            <tr key={ci} className={`border-t border-line ${c.kind === "gap" ? "text-ink-soft/70" : ""}`}>
                              <td className="py-1 pl-3 pr-3 text-right tabular-nums">{c.width_mm}</td>
                              <td className="py-1 pr-3">
                                <select
                                  value={c.kind}
                                  onChange={(e) => setColumnKind(wi, ci, e.target.value)}
                                  className="w-full border border-line rounded px-1 py-0.5 bg-transparent"
                                >
                                  {["base", "base_wall", "wall", "tall", "tall_wall", "gap"].map((k) => (
                                    <option key={k} value={k}>
                                      {k === "base_wall" ? "base + wall" : k === "tall_wall" ? "tall + wall (fridge column)" : k}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td className="py-1 pr-3 text-ink-soft">
                                <span className="block truncate" title={c.label}>{c.label}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p className="border-t border-line bg-paper px-3 py-1.5 text-ink-soft tabular-nums">
                        Base <b className="text-ink">{w.base / 1000}</b> lm · Wall <b className="text-ink">{w.wall / 1000}</b> lm · Tall <b className="text-ink">{w.tall / 1000}</b> lm
                      </p>
                    </div>
                  ))}
                </div>
              </details>
            )}
            {planResult.consistency_warnings && planResult.consistency_warnings.length > 0 && (() => {
              const uniq = Array.from(new Set(planResult.consistency_warnings));
              const major = uniq.filter((w) => /two independent reads|only one of two|could not be read/i.test(w));
              const minor = uniq.filter((w) => !major.includes(w));
              return (
                <details className="bg-amber-50 border border-amber-300 rounded-md p-3 mb-3 text-xs text-amber-900">
                  <summary className="cursor-pointer font-medium">
                    {uniq.length} note{uniq.length === 1 ? "" : "s"} where the two reads of this plan didn&apos;t fully agree
                    {major.length > 0 ? ` — ${major.length} worth a look` : ""} (click to review)
                  </summary>
                  {major.length > 0 && (
                    <>
                      <p className="mt-2 font-medium">Worth checking against the plan</p>
                      <ul className="list-disc pl-4 mt-1 space-y-0.5">
                        {major.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    </>
                  )}
                  {minor.length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer">Column-level detail ({minor.length}) — already settled by majority vote</summary>
                      <ul className="list-disc pl-4 mt-1 space-y-0.5">
                        {minor.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </details>
              );
            })()}
            {planResult.flags.length > 0 && (
              <details className="bg-paper border border-line rounded-md p-3 mb-3 text-xs text-ink-soft">
                <summary className="cursor-pointer font-medium text-ink">
                  {planResult.flags.length} thing{planResult.flags.length === 1 ? "" : "s"} to double-check before quoting (click to review)
                </summary>
                <ul className="list-disc pl-4 mt-1 space-y-0.5">
                  {planResult.flags.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </details>
            )}
            {planResult.items.length === 0 ? (
              <p className="text-sm text-ink-soft">No joinery items were identified on this plan.</p>
            ) : (
              <>
                <div className="flex gap-3 text-xs mb-1.5">
                  <button type="button" className="text-ink-soft underline" onClick={() => setExpandedPlanItems(new Set(planResult.items.map((_, k) => k)))}>
                    Expand all
                  </button>
                  <button type="button" className="text-ink-soft underline" onClick={() => setExpandedPlanItems(new Set())}>
                    Collapse all
                  </button>
                </div>
                <div className="border border-line rounded-md divide-y divide-line max-h-[70vh] overflow-y-auto mb-3">
                  {(() => {
                    const order: string[] = [];
                    const byRoom = new Map<string, number[]>();
                    planResult.items.forEach((it, i) => {
                      const r = (it.room || "General").trim() || "General";
                      if (!byRoom.has(r)) {
                        byRoom.set(r, []);
                        order.push(r);
                      }
                      byRoom.get(r)!.push(i);
                    });
                    return order.map((room) => {
                      const idxs = byRoom.get(room)!.filter((i) => !removedPlanItems.has(i));
                      if (idxs.length === 0) return null;
                      const ticked = idxs.filter((i) => selectedPlanItems.has(i)).length;
                      const roomNotes = (planResult.consistency_warnings || []).filter((w) => w.toUpperCase().includes(room.toUpperCase()));
                      return (
                        <details key={room} className="group/room">
                          <summary className="flex items-center gap-2 px-3 py-2 bg-paper cursor-pointer select-none list-none">
                            <span className="text-ink-soft text-xs w-4">▸</span>
                            <input
                              type="checkbox"
                              checked={ticked === idxs.length}
                              ref={(el) => {
                                if (el) el.indeterminate = ticked > 0 && ticked < idxs.length;
                              }}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => {
                                setSelectedPlanItems((prev) => {
                                  const next = new Set(prev);
                                  idxs.forEach((i) => (e.target.checked ? next.add(i) : next.delete(i)));
                                  return next;
                                });
                              }}
                              title="Tick / untick everything in this room"
                            />
                            <span className="font-semibold text-sm">{room}</span>
                            <span className="text-xs text-ink-soft">
                              {idxs.length} item{idxs.length === 1 ? "" : "s"} · {ticked} selected
                            </span>
                          </summary>
                          <div className="divide-y divide-line">
                            {roomNotes.length > 0 && (
                              <details className="px-3 py-2 text-xs text-amber-900 bg-amber-50">
                                <summary className="cursor-pointer">{roomNotes.length} note{roomNotes.length === 1 ? "" : "s"} for this room</summary>
                                <ul className="list-disc pl-4 mt-1 space-y-0.5">
                                  {Array.from(new Set(roomNotes)).map((w, k) => (
                                    <li key={k}>{w}</li>
                                  ))}
                                </ul>
                              </details>
                            )}
                            {idxs.map((i) => {
                    const it = planResult.items[i];
                    const options = materialOptionsFor(it);
                    const showMaterialPicker = options.length > 0;
                    return (
                      <div key={i} className="flex items-start gap-2 px-3 py-2 text-sm hover:bg-paper">
                        <button
                          type="button"
                          className="mt-0.5 w-5 text-ink-soft hover:text-ink shrink-0"
                          title={expandedPlanItems.has(i) ? "Hide details" : "Show details, notes and material"}
                          onClick={() =>
                            setExpandedPlanItems((prev) => {
                              const next = new Set(prev);
                              if (next.has(i)) next.delete(i);
                              else next.add(i);
                              return next;
                            })
                          }
                        >
                          {expandedPlanItems.has(i) ? "▾" : "▸"}
                        </button>
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={selectedPlanItems.has(i)}
                          onChange={(e) => {
                            setSelectedPlanItems((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(i);
                              else next.delete(i);
                              return next;
                            });
                          }}
                        />
                        <div className="flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium">{it.name}</span>
                            <span className="text-ink-soft">—</span>
                            <input
                              type="text"
                              className="w-28 px-1.5 py-0.5 text-sm border border-line-strong rounded"
                              value={it.room}
                              onChange={(e) => updatePlanItem(i, { room: e.target.value || "General" })}
                              title="Room — edit if the AI mislabeled this (e.g. guessed 'Kitchen' instead of the real room name)"
                            />
                            <span className="text-ink-soft">·</span>
                            {/* Editable — the AI read gets very close on a complex
                                multi-wall plan, but a vision read can land slightly
                                off on one wall's measured length; fixing the number
                                here takes seconds and beats another re-upload. */}
                            <input
                              type="number"
                              step="0.001"
                              min="0"
                              className="w-20 px-1.5 py-0.5 text-sm border border-line-strong rounded"
                              value={it.qty}
                              onChange={(e) => updatePlanItem(i, { qty: Number(e.target.value) || 0 })}
                              title="Quantity — edit if the AI's read looks off"
                            />
                            <span className="text-ink-soft">{it.unit}</span>
                            {it.drawer_count > 0 && (
                              <span className="text-ink-soft flex items-center gap-1">
                                ·
                                <input
                                  type="number"
                                  step="1"
                                  min="0"
                                  className="w-14 px-1.5 py-0.5 text-sm border border-line-strong rounded"
                                  value={it.drawer_count}
                                  onChange={(e) => {
                                    const next = Math.max(0, Math.round(Number(e.target.value) || 0));
                                    updatePlanItem(i, {
                                      drawer_count: next,
                                      pto_drawer_count: Math.min(it.pto_drawer_count, next),
                                    });
                                  }}
                                  title="Drawer count — edit if the AI's read looks off"
                                />
                                drawers
                                {it.pto_drawer_count > 0
                                  ? ` (${it.drawer_count - it.pto_drawer_count} standard + ${it.pto_drawer_count} PTO)`
                                  : ""}
                              </span>
                            )}
                            {it.regions && it.regions.length > 0 && (
                              <button
                                type="button"
                                onClick={() => openRegionPreview(it)}
                                className="text-xs text-brass hover:text-brass-deep underline underline-offset-2"
                                title="Show exactly where the AI read this on the plan"
                              >
                                📍 View on plan
                              </button>
                            )}
                          </div>
                          {!expandedPlanItems.has(i) && (planItemFlag[i] || it.duplicate_wall_warning || (showMaterialPicker && !planItemMaterial[i])) && (
                            <button
                              type="button"
                              className="text-xs text-brick mt-0.5 text-left"
                              onClick={() => setExpandedPlanItems((prev) => new Set(prev).add(i))}
                            >
                              ⚠ {showMaterialPicker && !planItemMaterial[i] ? "pick a material · " : ""}needs a look — open to review
                            </button>
                          )}
                          {expandedPlanItems.has(i) && (
                            <div className="mt-1 pl-1 border-l-2 border-line space-y-1">
                          {it.duplicate_wall_warning && (
                            <span className="block text-xs font-medium text-red-600 mt-0.5">
                              ⚠ {it.duplicate_wall_warning}
                            </span>
                          )}
                          {planItemFlag[i] && <span className="block text-xs text-brick mt-0.5">⚠ {planItemFlag[i]}</span>}
                          {it.drawer_count > 0 && (
                            <span className="block text-xs text-ink-soft">
                              Drawers priced in: {it.drawer_brand || "Merivo (default — none nominated)"}
                            </span>
                          )}
                          {showMaterialPicker && (
                            <select
                              className="input mt-1.5 text-xs"
                              style={{ marginBottom: 0 }}
                              value={planItemMaterial[i] || ""}
                              onChange={(e) => {
                                const value = e.target.value;
                                setPlanItemMaterial((prev) => ({ ...prev, [i]: value }));
                                // Manually picking counts as confirming it — drop the
                                // "closest match, please confirm" wording but keep
                                // anything else (location notes, low-confidence flag).
                                setPlanItemFlag((prev) => ({
                                  ...prev,
                                  [i]: [it.note, it.confidence === "low" ? "Low confidence — check on site." : ""]
                                    .filter(Boolean)
                                    .join(" "),
                                }));
                              }}
                            >
                              <option value="">
                                {it.material_hint ? `No confident match — plan says "${it.material_hint}"` : "Select item…"}
                              </option>
                              {options.map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.name} — ${money(Number(o.rate))}/{o.unit}
                                </option>
                              ))}
                            </select>
                          )}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          className="text-brick text-xs px-2 py-1 shrink-0"
                          title="Remove this line from the list"
                          onClick={() => {
                            setRemovedPlanItems((prev) => new Set(prev).add(i));
                            setSelectedPlanItems((prev) => {
                              const next = new Set(prev);
                              next.delete(i);
                              return next;
                            });
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    );
                            })}
                          </div>
                        </details>
                      );
                    });
                  })()}
                </div>
                <div className="flex gap-2 flex-wrap">
                  <button
                    onClick={openAllRegions}
                    className="border border-line-strong rounded-md px-3 py-1.5 text-sm hover:bg-paper"
                    title="Show every item's box on the plan together — handy for one screenshot"
                  >
                    📍 View all on plan
                  </button>
                  <button
                    onClick={addSelectedPlanItems}
                    disabled={selectedPlanItems.size === 0}
                    className="bg-brass hover:bg-brass-deep text-white rounded-md px-3 py-1.5 text-sm disabled:opacity-40"
                  >
                    Add selected to quote
                  </button>
                  <button
                    onClick={() => {
                      setPlanResult(null);
                      setPlanItemMaterial({});
                      setPlanItemFlag({});
                    }}
                    className="text-sm text-ink-soft underline"
                  >
                    Discard
                  </button>
                </div>
                <p className="text-xs text-ink-soft mt-2">
                  Materials are matched automatically from the drawing and finishes schedule — items marked ⚠ above
                  are worth double-checking before you quote.
                </p>
              </>
            )}
          </div>
        )}
      </section>

      {overview && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center p-4 overflow-auto"
          onClick={() => setOverview(null)}
        >
          <div
            className="bg-paper-raised rounded-lg p-4 max-w-5xl w-full my-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3 gap-3">
              <span className="font-medium text-sm">All items on the plan</span>
              <button onClick={() => setOverview(null)} className="text-ink-soft hover:text-ink text-lg leading-none">
                ✕
              </button>
            </div>
            {overview.error && <p className="text-sm text-brick py-6 text-center">{overview.error}</p>}
            {overview.loading && <p className="text-xs text-ink-soft mb-2">Rendering pages…</p>}
            {overview.legend.length > 0 && (
              <ol className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 mb-3 text-sm">
                {overview.legend.map((l) => (
                  <li key={l.n} className="flex items-center gap-2">
                    <span
                      className="inline-flex items-center justify-center w-5 h-5 rounded text-[11px] font-bold text-white shrink-0"
                      style={{ background: OVERVIEW_COLORS[(l.n - 1) % OVERVIEW_COLORS.length] }}
                    >
                      {l.n}
                    </span>
                    <span>
                      {l.name} — {l.qty}
                      {l.suspect && <span className="text-brick"> ⚠ box looks misplaced</span>}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {overview.noRegions.length > 0 && (
              <p className="text-xs text-ink-soft mb-3">
                No box was reported for: {overview.noRegions.join(", ")}.
              </p>
            )}
            <div className="space-y-4">
              {overview.pages.map((pg) => (
                <div key={pg.page}>
                  <p className="text-xs text-ink-soft mb-1">Page {pg.page}</p>
                  {pg.error && <p className="text-sm text-brick">{pg.error}</p>}
                  {!pg.imageUrl && !pg.error && <p className="text-sm text-ink-soft py-6 text-center">Rendering…</p>}
                  {pg.imageUrl && (
                    <img src={pg.imageUrl} alt={`Plan page ${pg.page}`} className="max-w-full rounded border border-line" />
                  )}
                </div>
              ))}
            </div>
            <p className="text-[11px] text-ink-soft mt-3">
              Boxes are the AI&apos;s own best guess at where it read each item — a visual cross-check, not a verified
              measurement.
            </p>
          </div>
        </div>
      )}

      {regionPreview && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={closeRegionPreview}
        >
          <div
            className="bg-paper-raised rounded-lg p-4 max-w-3xl w-full max-h-[90vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-2 gap-3">
              <span className="font-medium text-sm">
                {regionPreview.itemName} — page {regionPreview.regions[regionPreview.index].page}
                {regionPreview.regions.length > 1
                  ? ` (${regionPreview.index + 1} of ${regionPreview.regions.length})`
                  : ""}
              </span>
              <button onClick={closeRegionPreview} className="text-ink-soft hover:text-ink text-lg leading-none">
                ✕
              </button>
            </div>
            {regionPreview.loading && <p className="text-sm text-ink-soft py-8 text-center">Rendering page…</p>}
            {regionPreview.error && <p className="text-sm text-brick py-8 text-center">{regionPreview.error}</p>}
            {regionPreview.suspect && !regionPreview.loading && !regionPreview.error && (
              <p className="text-xs font-medium text-brick bg-paper border border-brick rounded px-2 py-1.5 mb-2">
                ⚠ This box sits well below where the rest of this page's items were found — it's likely landed in
                blank space rather than on the real cabinetry. Check the drawing yourself for this one.
              </p>
            )}
            {regionPreview.imageUrl && (
              <img src={regionPreview.imageUrl} alt="Plan region" className="max-w-full rounded border border-line" />
            )}
            {regionPreview.regions.length > 1 && (
              <div className="flex gap-2 mt-3">
                <button
                  onClick={() => stepRegionPreview(-1)}
                  disabled={regionPreview.index === 0}
                  className="text-sm px-3 py-1 border border-line-strong rounded disabled:opacity-40"
                >
                  ← Prev
                </button>
                <button
                  onClick={() => stepRegionPreview(1)}
                  disabled={regionPreview.index === regionPreview.regions.length - 1}
                  className="text-sm px-3 py-1 border border-line-strong rounded disabled:opacity-40"
                >
                  Next →
                </button>
              </div>
            )}
            <p className="text-[11px] text-ink-soft mt-2">
              This is the AI's own best guess at where it read this item — a visual cross-check, not a verified
              measurement.
            </p>
          </div>
        </div>
      )}

      {/* Ledger */}
      <section className="bg-paper-raised border border-line-strong rounded-lg p-5 mb-5">
        <h3 className="font-display text-sm font-semibold mb-3 text-ink-soft uppercase tracking-wide">
          Line items
        </h3>
        {lineItems.length === 0 ? (
          <p className="text-sm text-ink-soft">No items yet — search the price book above to add some.</p>
        ) : (
          <>
            <datalist id="quote-areas">
              {areas.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
            <div className="hidden sm:grid grid-cols-[2rem_1fr_6rem_7rem_7rem_7rem_2rem] gap-3 px-1 pb-2 text-xs font-semibold text-ink-soft uppercase tracking-wide border-b border-line">
              <span>#</span>
              <span>Item</span>
              <span className="text-right">Qty</span>
              <span className="text-right">Cost/unit</span>
              <span className="text-right">Sell/unit</span>
              <span className="text-right">Line total</span>
              <span />
            </div>
            <div className="divide-y divide-line">
              {lineItems.map((it, index) => (
                <LineItemRow
                  key={it.key}
                  index={index + 1}
                  item={it}
                  markupPct={Number(markupPct) || 0}
                  onChange={(patch) => updateItem(it.key, patch)}
                  onRemove={() => removeItem(it.key)}
                />
              ))}
            </div>
          </>
        )}
      </section>

      {/* Notes */}
      <section className="bg-paper-raised border border-line-strong rounded-lg p-5 mb-5">
        <h3 className="font-display text-sm font-semibold mb-3 text-ink-soft uppercase tracking-wide">
          Notes / inclusions
        </h3>
        <textarea
          className="input min-h-[100px]"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything the client should know — inclusions, exclusions, lead times…"
        />
      </section>

      {/* Totals */}
      <section className="bg-paper-raised border border-line-strong rounded-lg p-5">
        <div className="flex flex-col items-end gap-1.5 text-sm">
          <div className="flex justify-between w-64">
            <span className="text-ink-soft">Subtotal</span>
            <span className="font-mono">${money(subtotal)}</span>
          </div>
          <div className="flex justify-between w-64 items-center">
            <span className="text-ink-soft">Markup %</span>
            <input
              type="number"
              step="0.5"
              className="input w-24 text-right"
              value={markupPct}
              onChange={(e) => setMarkupPct(Number(e.target.value))}
            />
          </div>
          <div className="flex justify-between w-64">
            <span className="text-ink-soft">Markup amount</span>
            <span className="font-mono">${money(markupAmount)}</span>
          </div>
          <div className="flex justify-between w-64 text-base font-semibold border-t border-line-strong pt-1.5 mt-1">
            <span>Total</span>
            <span className="font-mono">${money(total)}</span>
          </div>
          {hasPoaItems && (
            <p className="text-xs text-ink-soft mt-1">Some items are marked POA and are excluded from this total.</p>
          )}
        </div>
      </section>

      <style jsx global>{`
        .input {
          width: 100%;
          padding: 8px 10px;
          border: 1px solid #b9ac94;
          border-radius: 4px;
          background: #faf9f5;
          font-size: 13.5px;
        }
        .input:focus {
          outline: 2px solid #2f6fb0;
          outline-offset: 1px;
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs text-ink-soft mb-1 font-medium">{label}</span>
      {children}
    </label>
  );
}

function LineItemRow({
  index,
  item,
  markupPct,
  onChange,
  onRemove,
}: {
  index: number;
  item: LineItem;
  markupPct: number;
  onChange: (patch: Partial<LineItem>) => void;
  onRemove: () => void;
}) {
  const [sellDraft, setSellDraft] = useState<string | null>(null);
  const sellRate = item.rate * (1 + markupPct / 100);
  const lineTotal = item.poa ? null : item.qty * sellRate;
  const showCategory = item.category && item.category !== "Custom" && item.category !== "From plan";

  return (
    <div className="grid grid-cols-1 sm:grid-cols-[2rem_1fr_6rem_7rem_7rem_7rem_2rem] gap-2 sm:gap-3 items-start py-3 px-1">
      <span className="hidden sm:block text-xs text-ink-soft pt-2">{index}</span>

      <div className="min-w-0">
        <input
          className="input font-medium"
          value={item.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Item name"
        />
        {showCategory && <p className="text-xs text-ink-soft mt-1">{item.category}</p>}
        {item.flag_label && (
          <p className="text-xs font-medium text-brick bg-paper border border-brick rounded px-2 py-1 mt-1.5">
            ⚠ {item.flag_label}
          </p>
        )}
        <label className="block mt-1.5">
          <span className="block text-[10px] uppercase tracking-wide text-ink-soft">PDF wording</span>
          <input
            className="input text-xs mt-0.5"
            placeholder="How this reads on the drawing (optional, shown on the quote if set)"
            value={item.pdf_label}
            onChange={(e) => onChange({ pdf_label: e.target.value })}
          />
        </label>
        <label className="block mt-1.5">
          <span className="block text-[10px] uppercase tracking-wide text-ink-soft">Room</span>
          <input
            className="input text-xs mt-0.5"
            list="quote-areas"
            value={item.area}
            onChange={(e) => onChange({ area: e.target.value || "General" })}
          />
        </label>
        <label className="block mt-1.5">
          <span className="block text-[10px] uppercase tracking-wide text-ink-soft">Note</span>
          <input
            className="input text-xs mt-0.5"
            placeholder="Note (shown on quote)"
            value={item.note}
            onChange={(e) => onChange({ note: e.target.value })}
          />
        </label>
      </div>

      <div>
        <span className="sm:hidden block text-[10px] uppercase tracking-wide text-ink-soft">Qty</span>
        <div className="flex items-center gap-1">
          <input
            type="number"
            step="0.01"
            className="input text-right"
            value={item.qty}
            onChange={(e) => onChange({ qty: Number(e.target.value) })}
            title="Quantity"
          />
          <span className="text-xs text-ink-soft shrink-0">{item.unit}</span>
        </div>
      </div>

      <div>
        <span className="sm:hidden block text-[10px] uppercase tracking-wide text-ink-soft">Cost/unit</span>
        <input
          type="number"
          step="0.01"
          className="input text-right"
          value={item.rate}
          onChange={(e) => onChange({ rate: Number(e.target.value) })}
          title="Cost per unit, before markup"
        />
      </div>

      <div>
        <span className="sm:hidden block text-[10px] uppercase tracking-wide text-ink-soft">Sell/unit</span>
        <input
          type="number"
          step="0.01"
          className="input text-right"
          value={sellDraft ?? (Math.round(sellRate * 100) / 100)}
          onFocus={() => setSellDraft(String(Math.round(sellRate * 100) / 100))}
          onChange={(e) => {
            setSellDraft(e.target.value);
            const v = parseFloat(e.target.value);
            onChange({ rate: Number.isFinite(v) ? v / (1 + markupPct / 100) : 0 });
          }}
          onBlur={() => setSellDraft(null)}
          title="Type a sell price here and it adds to the total (cost is back-calculated from the quote's markup %)"
        />
      </div>

      <div className="text-right">
        <span className="sm:hidden block text-[10px] uppercase tracking-wide text-ink-soft text-left">Line total</span>
        <span className="font-mono text-sm font-semibold">{item.poa ? "POA" : `$${money(lineTotal!)}`}</span>
        <label className="flex items-center justify-end gap-1 text-xs text-ink-soft whitespace-nowrap mt-1">
          <input type="checkbox" checked={item.poa} onChange={(e) => onChange({ poa: e.target.checked })} />
          POA
        </label>
      </div>

      <div className="flex sm:block justify-end">
        <button onClick={onRemove} className="text-brick text-xs px-2 py-2" title="Remove item">
          ✕
        </button>
      </div>
    </div>
  );
}

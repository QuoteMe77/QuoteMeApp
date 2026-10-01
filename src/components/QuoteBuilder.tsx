"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveQuote, deleteQuoteAndRedirect, type QuoteItemInput, type QuoteMetaInput } from "@/app/dashboard/quotes/actions";
import { createClient as createBrowserClient } from "@/lib/supabase/client";
import { downloadQuotePdf } from "@/lib/exportPdf";
import { downloadQuoteDocx } from "@/lib/exportDocx";
import { PDFDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";

// Above this size, a PDF is routed through the page-picker instead of being
// uploaded whole — a full multi-trade construction document set can run to
// 60-100MB, well past both Supabase Storage's 50MB free-plan ceiling and
// Claude's own 32MB-per-PDF limit, and almost always contains far more than
// the joinery-relevant sheets anyway.
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

type Calc = "LM" | "QTY" | "MISC";

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
    drawer_brand: string;
    note: string;
    confidence: string;
  };

  const [planUploading, setPlanUploading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planResult, setPlanResult] = useState<{ items: PlanItemResult[]; flags: string[] } | null>(null);
  const [selectedPlanItems, setSelectedPlanItems] = useState<Set<number>>(new Set());
  // index -> chosen price_book_items.id for base/wall/tall items awaiting a material pick
  const [planItemMaterial, setPlanItemMaterial] = useState<Record<number, string>>({});
  // index -> note explaining the match (or lack of one) for that item, shown to the estimator
  const [planItemFlag, setPlanItemFlag] = useState<Record<number, string>>({});
  const [scheduleFileName, setScheduleFileName] = useState<string | null>(null);
  const scheduleFileRef = useRef<File | null>(null);

  function categoryPrefixFor(cabinetType: string): string | null {
    if (cabinetType === "base") return "Base cabinets";
    if (cabinetType === "wall") return "Wall cabinets";
    if (cabinetType === "tall") return "Tall cabinets";
    return null;
  }

  function materialOptionsFor(it: PlanItemResult): PriceBookItem[] {
    const prefix = categoryPrefixFor(it.cabinet_type);
    if (!prefix) return [];
    return priceBook.filter(
      (p) => p.calc === "LM" && p.category.startsWith(prefix) && /open/i.test(p.name) === it.open
    );
  }

  const MATERIAL_STOPWORDS = new Set([
    "mm", "with", "and", "the", "including", "collection", "series", "range", "doors", "door", "panel",
    "from", "white", "cabinet", "base", "wall", "tall", "open",
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

    let best: PriceBookItem | null = null;
    let bestScore = 0;
    for (const o of options) {
      const words = materialKeywords(o.name);
      const score = words.filter((w) => hintSet.has(w)).length;
      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }
    if (!best) return { match: null, exact: false };
    return { match: best, exact: bestScore >= 2 };
  }

  function findDrawerHardware(brand: string): PriceBookItem | null {
    const hint = (brand.trim() || "Merivo").toLowerCase();
    const drawerItems = priceBook.filter((p) => p.category.toLowerCase() === "hardware" && /^drawer -/i.test(p.name));
    // The drawing/schedule brand text often carries a manufacturer or colour
    // prefix the price book doesn't (e.g. "Blum Black Legrabox" vs the price
    // book's "Legrabox (16mm ONLY)"), so check whether the hint *contains*
    // the price book's brand word rather than the other way around.
    const matches = drawerItems.filter((p) => {
      const brandWord = p.name.replace(/^drawer\s*-\s*/i, "").split(/[\s(]/)[0].toLowerCase();
      return brandWord.length > 0 && hint.includes(brandWord);
    });
    const pool = matches.length > 0 ? matches : drawerItems.filter((p) => p.name.toLowerCase().includes("merivo"));
    return pool.find((c) => !/push to open/i.test(c.name)) || pool[0] || null;
  }

  // Builds the amber confirmation note shown under a plan-read item: carries
  // forward anything the AI noted about the item, then explains how the
  // material got matched (or why it couldn't be) so the estimator knows
  // exactly what to double-check rather than just seeing a bare "confirm".
  function buildMaterialFlag(it: PlanItemResult, matched: PriceBookItem | null, exact: boolean): string {
    const parts: string[] = [];
    if (it.note) parts.push(it.note);
    const needsMaterial = categoryPrefixFor(it.cabinet_type) !== null;
    if (needsMaterial) {
      if (matched && exact) {
        // Confident match — nothing further to add.
      } else if (matched && !exact) {
        parts.push(
          `Closest price-book match to the drawing's "${it.material_hint || "unspecified finish"}" — confirm there's no cost delta for the exact colour/finish.`
        );
      } else if (it.material_hint) {
        parts.push(`Could not match "${it.material_hint}" in the price book — please pick the closest material.`);
      } else {
        parts.push("No material specified on the drawing or schedule — please select one.");
      }
    }
    if (it.confidence === "low") parts.push("Low confidence — check on site.");
    return parts.join(" ");
  }

  function storagePathFor(userId: string, file: File) {
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    return `${userId}/${Date.now()}-${safeName}`;
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

  async function runPlanRead(planFile: File, scheduleFile: File | null) {
    setPlanUploading(true);
    setPlanError(null);
    setPlanResult(null);
    setPlanItemMaterial({});
    setPlanItemFlag({});

    // Checked here, before anything is uploaded, because this is the one
    // call site every upload path goes through (direct or via the page
    // picker) — catches the Anthropic request-size limit regardless of how
    // the files got here, rather than finding out from a 413 afterwards.
    const estimatedRequestBytes = estimateBase64Size(planFile.size) + estimateBase64Size(scheduleFile?.size ?? 0);
    if (estimatedRequestBytes > ANTHROPIC_REQUEST_LIMIT_BYTES) {
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

      // Uploaded straight to storage from the browser, not through our own
      // API route: Vercel's serverless functions reject any request body
      // over ~4.5MB, and a real plan or schedule PDF routinely exceeds that.
      const planPath = storagePathFor(user.id, planFile);
      const { error: planUploadError } = await supabase.storage
        .from("plan-uploads")
        .upload(planPath, planFile, { contentType: planFile.type });
      if (planUploadError) {
        setPlanError("Could not upload the plan. Please try again.");
        return;
      }

      let schedulePath: string | null = null;
      if (scheduleFile) {
        schedulePath = storagePathFor(user.id, scheduleFile);
        const { error: scheduleUploadError } = await supabase.storage
          .from("plan-uploads")
          .upload(schedulePath, scheduleFile, { contentType: scheduleFile.type });
        if (scheduleUploadError) {
          setPlanError("Could not upload the finishes schedule. Please try again.");
          return;
        }
      }

      const res = await fetch("/api/plans/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planPath, schedulePath }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPlanError(data.error || "Could not read this plan.");
        return;
      }
      setPlanResult(data);
      setSelectedPlanItems(new Set(data.items.map((_: unknown, i: number) => i)));
      const defaults: Record<number, string> = {};
      const flags: Record<number, string> = {};
      (data.items as PlanItemResult[]).forEach((it, i) => {
        const options = materialOptionsFor(it);
        const { match, exact } = bestMaterialMatch(options, it.material_hint);
        if (match) defaults[i] = match.id;
        flags[i] = buildMaterialFlag(it, match, exact);
      });
      setPlanItemMaterial(defaults);
      setPlanItemFlag(flags);
    } catch {
      setPlanError("Upload failed. Check your connection and try again.");
    } finally {
      setPlanUploading(false);
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

  async function handlePlanUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    if (file.type === "application/pdf" && file.size > PDF_PICKER_THRESHOLD_BYTES) {
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

  function addSelectedPlanItems() {
    if (!planResult) return;
    const toAdd = planResult.items
      .map((it, i) => ({ it, i }))
      .filter(({ i }) => selectedPlanItems.has(i));

    const newLines: LineItem[] = [];
    toAdd.forEach(({ it, i }) => {
      const chosenId = planItemMaterial[i];
      const chosen = chosenId ? priceBook.find((p) => p.id === chosenId) : null;

      newLines.push({
        key: newKey(),
        price_book_item_id: chosen?.id ?? null,
        name: it.name,
        category: chosen?.category ?? "From plan",
        calc: it.calc,
        unit: chosen?.unit ?? it.unit,
        rate: chosen ? Number(chosen.rate) : 0,
        qty: it.qty,
        area: it.room || "General",
        note: chosen ? chosen.name : "",
        pdf_label: it.name,
        poa: false,
        flag_label: planItemFlag[i] ?? "",
      });

      if (it.drawer_count > 0) {
        const hardware = findDrawerHardware(it.drawer_brand);
        newLines.push({
          key: newKey(),
          price_book_item_id: hardware?.id ?? null,
          name: hardware ? hardware.name : `Drawers — ${it.drawer_brand || "Merivo"} (not in price book)`,
          category: "Hardware",
          calc: "QTY",
          unit: hardware?.unit ?? "ea",
          rate: hardware ? Number(hardware.rate) : 0,
          qty: it.drawer_count,
          area: it.room || "General",
          note: `For: ${it.name}`,
          pdf_label: "",
          poa: false,
          flag_label: hardware ? "" : "Select drawer hardware",
        });
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

  function handleExportPdf() {
    downloadQuotePdf(buildExportData(), `${quoteRef || "quote"}.pdf`);
  }

  function handleExportDocx() {
    downloadQuoteDocx(buildExportData(), `${quoteRef || "quote"}.docx`);
  }

  function handleDelete() {
    if (!quote?.id) return;
    if (!window.confirm("Delete this quote? This cannot be undone.")) return;
    startTransition(async () => {
      await deleteQuoteAndRedirect(quote.id);
    });
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
            {planUploading ? "Reading plan…" : "Upload a plan (PNG, JPEG or PDF)"}
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
            {planResult.flags.length > 0 && (
              <div className="bg-paper border border-line rounded-md p-3 mb-3 text-xs text-ink-soft">
                <span className="font-semibold text-brick">Double-check before quoting: </span>
                {planResult.flags.join(" • ")}
              </div>
            )}
            {planResult.items.length === 0 ? (
              <p className="text-sm text-ink-soft">No joinery items were identified on this plan.</p>
            ) : (
              <>
                <div className="border border-line rounded-md divide-y divide-line max-h-96 overflow-y-auto mb-3">
                  {planResult.items.map((it, i) => {
                    const options = materialOptionsFor(it);
                    const showMaterialPicker = options.length > 0;
                    return (
                      <div key={i} className="flex items-start gap-2 px-3 py-2 text-sm hover:bg-paper">
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
                            <span className="text-ink-soft">
                              — {it.room} · {it.qty} {it.unit}
                              {it.drawer_count > 0 && ` · ${it.drawer_count} drawers`}
                            </span>
                          </div>
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
                                {it.material_hint ? `No match — plan says "${it.material_hint}"` : "Select material…"}
                              </option>
                              {options.map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.name} — ${money(Number(o.rate))}/{o.unit}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="flex gap-2">
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
        <div className="input text-right bg-paper text-ink-soft" title="Cost/unit plus the quote's markup %">
          ${money(sellRate)}
        </div>
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

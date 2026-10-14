import jsPDF from "jspdf";
import { VICELLO_FOOTER_LINES, VICELLO_LOGO_PNG, VICELLO_LOGO_RATIO, VICELLO_MARK_PNG, isVicello } from "./brandAssets";
import { APPROVAL_TEXT, STANDARD_INCLUSIONS, TERMS_SECTIONS, parseTermLine, quoteAreaGroups } from "./quoteTerms";

export type ExportLineItem = {
  name: string;
  category: string;
  unit: string;
  rate: number;
  qty: number;
  area: string;
  note: string;
  poa: boolean;
};

export type ExportQuote = {
  businessName: string;
  businessContact: string;
  builderName: string;
  clientName: string;
  jobAddress: string;
  quoteRef: string;
  quoteDate: string;
  validDays: number;
  markupPct: number;
  notes: string;
  items: ExportLineItem[];
  subtotal: number;
  markupAmount: number;
  total: number;
};

type RGB = [number, number, number];
const ink: RGB = [36, 30, 23];
const brass: RGB = [139, 126, 110]; // warm grey accent
const soft: RGB = [107, 96, 83];
const band: RGB = [245, 241, 235];
const line: RGB = [221, 213, 198];

function money(n: number) {
  return n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function buildQuotePdf(quote: ExportQuote): jsPDF {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const mx = 56;
  const cw = W - mx * 2;
  const bottom = H - 84;
  let y = 56;

  const setFont = (f: "helvetica" | "times", st: "normal" | "bold" | "italic", size: number, color: RGB) => {
    doc.setFont(f, st);
    doc.setFontSize(size);
    doc.setTextColor(...color);
  };
  const need = (h: number) => {
    if (y + h > bottom) {
      doc.addPage();
      y = 56;
    }
  };
  const spacedText = (t: string, x: number, yy: number, cs: number, align: "left" | "right" = "left") => {
    doc.setCharSpace(cs);
    const w = doc.getTextWidth(t) + t.length * cs;
    doc.text(t, align === "right" ? x - w + cs : x, yy);
    doc.setCharSpace(0);
  };
  const sectionHeading = (title: string) => {
    need(50);
    y += 10;
    setFont("helvetica", "bold", 8.5, brass);
    spacedText(title.toUpperCase(), mx, y, 2);
    y += 7;
    doc.setDrawColor(...brass);
    doc.setLineWidth(0.6);
    doc.line(mx, y, W - mx, y);
    y += 16;
  };
  const bullets = (items: string[], fontSize = 9) => {
    items.forEach((raw) => {
      const t = parseTermLine(raw);
      const indent = t.kind === "note" ? 0 : 16;
      const maxW = cw - indent - (t.kind === "note" ? 0 : 0);
      const font = t.kind === "note" ? "italic" : "normal";
      doc.setFont("helvetica", font);
      doc.setFontSize(t.kind === "note" ? fontSize - 0.5 : fontSize);
      const full = t.lead ? `${t.lead} ${t.text}` : t.text;
      const lines = doc.splitTextToSize(full, maxW) as string[];
      need(lines.length * (fontSize + 3) + 4);
      if (t.kind === "bullet") {
        doc.setFillColor(...brass);
        doc.circle(mx + 6, y - 2.6, 1.1, "F");
      }
      lines.forEach((ln, i) => {
        let x = mx + indent;
        if (i === 0 && t.lead) {
          setFont("helvetica", "bold", fontSize, ink);
          doc.text(t.lead, x, y);
          const lw = doc.getTextWidth(t.lead + " ");
          setFont("helvetica", "normal", fontSize, ink);
          doc.text(ln.slice(t.lead.length + 1), x + lw, y);
        } else {
          setFont("helvetica", t.kind === "note" ? "italic" : "normal", t.kind === "note" ? fontSize - 0.5 : fontSize, t.kind === "note" ? soft : ink);
          doc.text(ln, x, y);
        }
        y += fontSize + 3;
      });
      y += 2;
    });
  };

  // ---- Header ----
  const vic = isVicello(quote.businessName);
  if (vic) {
    const lh = 38;
    doc.addImage("data:image/png;base64," + VICELLO_LOGO_PNG, "PNG", mx, y - 22, lh * VICELLO_LOGO_RATIO, lh);
  } else {
    setFont("times", "bold", 17, ink);
    const name = (quote.businessName || "Business Name").toUpperCase();
    doc.setCharSpace(3);
    let fs = 17;
    while (fs > 10 && doc.getTextWidth(name) + name.length * 3 > cw * 0.6) {
      fs -= 1;
      doc.setFontSize(fs);
    }
    doc.text(name, mx, y);
    doc.setCharSpace(0);
  }
  setFont("times", "normal", 19, ink);
  spacedText("QUOTATION", W - mx, y + 2, 4.5, "right");
  setFont("helvetica", "normal", 8.5, soft);
  doc.text([quote.clientName, quote.quoteRef ? `Ref ${quote.quoteRef}` : ""].filter(Boolean).join(" · "), W - mx, y + 17, { align: "right" });
  if (!vic && quote.businessContact) doc.text(quote.businessContact, mx, y + 17, { maxWidth: cw * 0.6 });
  y += 62;

  // ---- Details grid ----
  const rows: [string, string, string, string][] = [
    ["Client name", quote.clientName || "—", "Date", quote.quoteDate || "—"],
    ["Site address", quote.jobAddress || "—", "Job #", quote.quoteRef || "—"],
    ["Consultant", quote.builderName || "—", "Valid for", `${quote.validDays} days`],
  ];
  const lw = 88, rw = 74, half = cw / 2 + 10;
  rows.forEach((r) => {
    setFont("helvetica", "normal", 9.5, ink);
    const l1 = doc.splitTextToSize(r[1], half - lw - 16) as string[];
    const l3 = doc.splitTextToSize(r[3], cw - half - rw - 16) as string[];
    const rh = Math.max(26, Math.max(l1.length, l3.length) * 12 + 14);
    doc.setFillColor(...band);
    doc.rect(mx, y, lw, rh, "F");
    doc.rect(mx + half, y, rw, rh, "F");
    setFont("helvetica", "bold", 7, soft);
    spacedText(r[0].toUpperCase(), mx + 8, y + 16, 1);
    spacedText(r[2].toUpperCase(), mx + half + 8, y + 16, 1);
    setFont("helvetica", "normal", 9.5, ink);
    doc.text(l1, mx + lw + 8, y + 16);
    doc.text(l3, mx + half + rw + 8, y + 16);
    y += rh + 2;
  });
  y += 8;

  const groups = quoteAreaGroups(quote.items);
  const areaPrice = (g: { included: ExportLineItem[] }) =>
    g.included.reduce((sum, it) => sum + it.qty * it.rate, 0) * (1 + quote.markupPct / 100);

  // ---- Summary ----
  sectionHeading("Quote Summary");
  y -= 8;
  setFont("helvetica", "bold", 7.5, soft);
  spacedText("#", mx + 4, y, 1);
  spacedText("AREA", mx + 40, y, 1);
  spacedText("PRICE EX GST", W - mx - 4, y, 1, "right");
  y += 6;
  doc.setDrawColor(...ink);
  doc.setLineWidth(0.8);
  doc.line(mx, y, W - mx, y);
  const sumRow = (idx: string, label: string, price: string, hasPoa: boolean, shade: boolean) => {
    need(20);
    if (shade) {
      doc.setFillColor(248, 245, 238);
      doc.rect(mx, y, cw, 19, "F");
    }
    setFont("helvetica", "normal", 8, soft);
    doc.text(idx, mx + 4, y + 13);
    setFont("helvetica", "normal", 10, ink);
    doc.text(label, mx + 40, y + 13, { maxWidth: cw - 170 });
    // The price always sits on the right edge so every figure lines up; "+ POA" goes to its left.
    setFont("helvetica", "normal", 10, ink);
    doc.text(price, W - mx - 4, y + 13, { align: "right" });
    if (hasPoa) {
      const pw = doc.getTextWidth(price);
      setFont("helvetica", "bold", 7, brass);
      doc.text("+ POA", W - mx - 4 - pw - 8, y + 13, { align: "right" });
    }
    y += 19;
  };
  sumRow("—", "Standard Inclusions", "", false, false);
  setFont("helvetica", "bold", 7.5, brass);
  doc.text("INCLUDED", W - mx - 4, y - 6, { align: "right" });
  groups.forEach((g, i) => sumRow(String(i + 1).padStart(2, "0"), g.area, `$${money(areaPrice(g))}`, g.poa.length > 0, i % 2 === 0));
  y += 10;

  const subtotal = quote.total;
  const gst = subtotal * 0.1;
  need(80);
  setFont("helvetica", "normal", 10, soft);
  doc.text("Subtotal (ex GST)", W - mx - 150, y, { align: "right" });
  doc.text("GST (10%)", W - mx - 150, y + 16, { align: "right" });
  setFont("helvetica", "bold", 10, ink);
  doc.text(`$${money(subtotal)}`, W - mx - 4, y, { align: "right" });
  doc.text(`$${money(gst)}`, W - mx - 4, y + 16, { align: "right" });
  y += 26;
  doc.setFillColor(...ink);
  doc.rect(mx, y, cw, 28, "F");
  setFont("helvetica", "bold", 11, [255, 255, 255]);
  doc.text("Total (inc GST)", W - mx - 150, y + 18, { align: "right" });
  setFont("helvetica", "bold", 13, [255, 255, 255]);
  doc.text(`$${money(subtotal + gst)}`, W - mx - 8, y + 18, { align: "right" });
  y += 40;
  setFont("helvetica", "italic", 7.5, soft);
  doc.text(
    doc.splitTextToSize("All prices are excluding GST unless stated. Items marked POA (price on application) are excluded from the totals and priced separately.", cw),
    mx,
    y
  );
  y += 16;

  // ---- Scope of works ----
  doc.addPage();
  y = 56;
  sectionHeading("Scope of Works");
  const areaBand = (num: string, title: string, price: string, hasPoa: boolean) => {
    need(60);
    doc.setFillColor(...band);
    doc.rect(mx, y, cw, 24, "F");
    doc.setFillColor(...ink);
    doc.rect(mx, y, 3, 24, "F");
    setFont("helvetica", "normal", 8.5, soft);
    doc.text(num, mx + 14, y + 16);
    setFont("times", "bold", 12, ink);
    doc.text(title, mx + 34, y + 16, { maxWidth: cw - 160 });
    if (price) {
      setFont("helvetica", "bold", 10.5, ink);
      doc.text(price, W - mx - 8, y + 16, { align: "right" });
      if (hasPoa) {
        const pw = doc.getTextWidth(price);
        setFont("helvetica", "bold", 7, brass);
        doc.text("+ POA", W - mx - 8 - pw - 8, y + 16, { align: "right" });
      }
    } else {
      setFont("helvetica", "bold", 7.5, brass);
      doc.text("INCLUDED", W - mx - 8, y + 16, { align: "right" });
    }
    y += 36;
  };
  areaBand("00", "Standard Inclusions", "", false);
  bullets(STANDARD_INCLUSIONS);
  y += 10;
  groups.forEach((g, i) => {
    areaBand(String(i + 1).padStart(2, "0"), g.area, `$${money(areaPrice(g))}`, g.poa.length > 0);
    g.included.forEach((it) => {
      bullets([it.note ? `${it.name} — ${it.note}` : it.name], 9.5);
    });
    if (g.poa.length > 0) {
      need(30);
      y += 4;
      setFont("helvetica", "bold", 7, brass);
      doc.setCharSpace(0.8);
      doc.text("PRICE ON APPLICATION — NOT INCLUDED IN THE PRICE ABOVE", mx, y);
      doc.setCharSpace(0);
      y += 12;
      g.poa.forEach((it) => {
        const t = doc.splitTextToSize(it.note ? `${it.name} — ${it.note}` : it.name, cw - 30) as string[];
        need(t.length * 12);
        setFont("helvetica", "normal", 9, soft);
        doc.text("–", mx + 6, y);
        t.forEach((ln) => {
          doc.text(ln, mx + 18, y);
          y += 12;
        });
      });
    }
    y += 16;
  });

  // ---- Notes ----
  if (quote.notes.trim()) {
    sectionHeading("Notes");
    quote.notes.split("\n").forEach((ln) => {
      if (!ln.trim()) return;
      const t = doc.splitTextToSize(ln, cw) as string[];
      need(t.length * 12);
      setFont("helvetica", "italic", 9, soft);
      doc.text(t, mx, y);
      y += t.length * 12 + 2;
    });
  }

  // ---- Terms & conditions (every quote) ----
  TERMS_SECTIONS.forEach((sec) => {
    sectionHeading(sec.title);
    sec.groups.forEach((g) => {
      if (g.heading) {
        need(30);
        setFont("helvetica", "bold", 9.5, ink);
        doc.text(g.heading, mx, y);
        y += 13;
      }
      bullets(g.items);
      y += 4;
    });
  });

  // ---- Client approval ----
  sectionHeading("Client Approval");
  need(150);
  setFont("helvetica", "normal", 9.5, soft);
  doc.text(APPROVAL_TEXT, mx, y);
  y += 34;
  ["Client name", "Client signature", "Date"].forEach((l) => {
    setFont("helvetica", "bold", 7.5, soft);
    doc.setCharSpace(1);
    doc.text(l.toUpperCase(), mx, y);
    doc.setCharSpace(0);
    doc.setDrawColor(...ink);
    doc.setLineWidth(0.6);
    doc.line(mx + 120, y + 3, W - mx, y + 3);
    y += 34;
  });

  // ---- Footer on every page ----
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setDrawColor(...line);
    doc.setLineWidth(0.5);
    doc.line(mx, H - 66, W - mx, H - 66);
    if (vic) {
      doc.addImage("data:image/png;base64," + VICELLO_MARK_PNG, "PNG", W / 2 - 8, H - 62, 16, 16);
      setFont("helvetica", "normal", 7, soft);
      VICELLO_FOOTER_LINES.forEach((t, i) => doc.text(t, W / 2, H - 38 + i * 9, { align: "center" }));
    } else {
      setFont("helvetica", "normal", 7.5, soft);
      doc.text([quote.businessName, quote.businessContact].filter(Boolean).join("  ·  "), W / 2, H - 44, { align: "center" });
    }
    setFont("helvetica", "normal", 8, soft);
    doc.text(`${p} / ${pages}`, W - mx, H - 18, { align: "right" });
  }
  return doc;
}

export function downloadQuotePdf(quote: ExportQuote, filename: string) {
  const doc = buildQuotePdf(quote);
  doc.save(filename);
}

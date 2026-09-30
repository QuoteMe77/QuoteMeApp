import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

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

const inkColor: [number, number, number] = [36, 30, 23];
const brassColor: [number, number, number] = [156, 107, 46];
const softColor: [number, number, number] = [107, 96, 83];

function money(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Renders the business name as a letter-spaced wordmark, shrinking the font
 * size until it fits the page width. jsPDF's built-in font metrics only
 * measure plain ASCII spaces accurately (a real-world lesson from the
 * original QuoteMe artifact — wide Unicode spacers under-report their
 * rendered width and silently overflow the page), so a plain space is used
 * as the letter-spacing character rather than an em-space or similar.
 */
function drawWordmark(doc: jsPDF, businessName: string, pageW: number, marginX: number, y: number): number {
  const raw = (businessName || "Business Name").toUpperCase();
  const spaced = raw.split("").join(" ");
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...inkColor);
  const maxW = pageW - marginX * 2;
  let fontSize = 22;
  doc.setFontSize(fontSize);
  while (fontSize > 11 && doc.getTextWidth(spaced) > maxW) {
    fontSize -= 1;
    doc.setFontSize(fontSize);
  }
  doc.text(spaced, pageW / 2, y, { align: "center" });
  return y + fontSize * 0.9;
}

export function buildQuotePdf(quote: ExportQuote): jsPDF {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const marginX = 40;
  let y = 48;

  y = drawWordmark(doc, quote.businessName, pageW, marginX, y) + 6;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.setTextColor(...softColor);
  if (quote.businessContact) {
    doc.text(quote.businessContact, pageW / 2, y, { align: "center" });
    y += 22;
  } else {
    y += 12;
  }

  doc.setDrawColor(185, 172, 148);
  doc.line(marginX, y, pageW - marginX, y);
  y += 20;

  // Two-column job details block.
  doc.setFontSize(10);
  const leftX = marginX;
  const rightX = pageW / 2 + 10;
  const detailRows: [string, string][] = [
    ["Quote ref", quote.quoteRef || "—"],
    ["Quote date", quote.quoteDate || "—"],
    ["Valid for", `${quote.validDays} days`],
    ["Client", quote.clientName || "—"],
    ["Job address", quote.jobAddress || "—"],
    ["Prepared by", quote.builderName || "—"],
  ];
  let leftY = y;
  let rightY = y;
  detailRows.forEach(([label, value], i) => {
    const targetX = i % 2 === 0 ? leftX : rightX;
    const targetY = i % 2 === 0 ? leftY : rightY;
    doc.setTextColor(...softColor);
    doc.text(label.toUpperCase(), targetX, targetY);
    doc.setTextColor(...inkColor);
    doc.text(String(value), targetX, targetY + 13);
    if (i % 2 === 0) leftY += 34;
    else rightY += 34;
  });
  y = Math.max(leftY, rightY) + 6;

  // Line items, grouped by area, one autoTable per area so each room gets
  // its own heading row.
  const areas = Array.from(new Set(quote.items.map((it) => it.area || "General")));
  areas.forEach((area) => {
    const rows = quote.items.filter((it) => (it.area || "General") === area);
    if (rows.length === 0) return;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.setTextColor(...brassColor);
    doc.text(area, marginX, y + 12);
    y += 18;

    autoTable(doc, {
      startY: y,
      margin: { left: marginX, right: marginX },
      head: [["Item", "Qty", "Unit", "Rate", "Total"]],
      body: rows.map((it) => [
        it.note ? `${it.name}\n${it.note}` : it.name,
        String(it.qty),
        it.unit,
        it.poa ? "POA" : `$${money(it.rate)}`,
        it.poa ? "POA" : `$${money(it.qty * it.rate)}`,
      ]),
      styles: { fontSize: 9, textColor: inkColor, cellPadding: 5 },
      headStyles: { fillColor: [239, 234, 224], textColor: inkColor, fontStyle: "bold" },
      alternateRowStyles: { fillColor: [251, 248, 243] },
      columnStyles: {
        1: { cellWidth: 40, halign: "right" },
        2: { cellWidth: 50 },
        3: { cellWidth: 70, halign: "right" },
        4: { cellWidth: 70, halign: "right" },
      },
      didDrawPage: (data) => {
        y = data.cursor?.y ?? y;
      },
    });

    // @ts-expect-error jspdf-autotable augments the doc instance at runtime
    y = (doc.lastAutoTable?.finalY ?? y) + 18;
  });

  // Notes.
  if (quote.notes) {
    if (y > 700) {
      doc.addPage();
      y = 48;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.setTextColor(...brassColor);
    doc.text("Notes & inclusions", marginX, y);
    y += 16;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(...inkColor);
    const wrapped = doc.splitTextToSize(quote.notes, pageW - marginX * 2);
    doc.text(wrapped, marginX, y);
    y += wrapped.length * 12 + 16;
  }

  // Totals.
  if (y > 720) {
    doc.addPage();
    y = 48;
  }
  const totalsX = pageW - marginX - 180;
  doc.setDrawColor(185, 172, 148);
  doc.line(totalsX, y, pageW - marginX, y);
  y += 16;
  doc.setFontSize(10);
  doc.setTextColor(...softColor);
  doc.text("Subtotal", totalsX, y);
  doc.setTextColor(...inkColor);
  doc.text(`$${money(quote.subtotal)}`, pageW - marginX, y, { align: "right" });
  y += 16;
  doc.setTextColor(...softColor);
  doc.text(`Markup (${quote.markupPct}%)`, totalsX, y);
  doc.setTextColor(...inkColor);
  doc.text(`$${money(quote.markupAmount)}`, pageW - marginX, y, { align: "right" });
  y += 18;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("Total", totalsX, y);
  doc.text(`$${money(quote.total)}`, pageW - marginX, y, { align: "right" });

  return doc;
}

export function downloadQuotePdf(quote: ExportQuote, filename: string) {
  const doc = buildQuotePdf(quote);
  doc.save(filename);
}

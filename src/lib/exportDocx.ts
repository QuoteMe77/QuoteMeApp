import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { saveAs } from "file-saver";
import type { ExportQuote } from "./exportPdf";

function money(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function headerCell(text: string, width: number) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: { type: ShadingType.CLEAR, fill: "EFEAE0" },
    children: [new Paragraph({ children: [new TextRun({ text, bold: true, size: 18 })] })],
  });
}

function bodyCell(text: string, width: number, align: (typeof AlignmentType)[keyof typeof AlignmentType] = AlignmentType.LEFT) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    children: [new Paragraph({ alignment: align, children: [new TextRun({ text, size: 18 })] })],
  });
}

export async function buildQuoteDocx(quote: ExportQuote): Promise<Blob> {
  const wordmarkRaw = (quote.businessName || "Business Name").toUpperCase();
  const wordmarkSize =
    wordmarkRaw.length > 16 ? Math.max(24, Math.round(40 * (16 / wordmarkRaw.length))) : 40;

  const children: (Paragraph | Table)[] = [];

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [new TextRun({ text: wordmarkRaw.split("").join(" "), bold: true, size: wordmarkSize })],
    })
  );
  if (quote.businessContact) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 300 },
        children: [new TextRun({ text: quote.businessContact, size: 18, color: "6B6053" })],
      })
    );
  }

  const detailPairs: [string, string][] = [
    ["Quote ref", quote.quoteRef || "—"],
    ["Quote date", quote.quoteDate || "—"],
    ["Valid for", `${quote.validDays} days`],
    ["Client", quote.clientName || "—"],
    ["Job address", quote.jobAddress || "—"],
    ["Prepared by", quote.builderName || "—"],
  ];
  detailPairs.forEach(([label, value]) => {
    children.push(
      new Paragraph({
        spacing: { after: 60 },
        children: [
          new TextRun({ text: `${label}: `, bold: true, size: 18, color: "6B6053" }),
          new TextRun({ text: value, size: 18 }),
        ],
      })
    );
  });

  const areas = Array.from(new Set(quote.items.map((it) => it.area || "General")));
  const colWidths = [4500, 1200, 1200, 1500, 1500]; // sums to 9900 DXA

  areas.forEach((area) => {
    const rows = quote.items.filter((it) => (it.area || "General") === area);
    if (rows.length === 0) return;

    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 300, after: 120 },
        children: [new TextRun({ text: area, bold: true, color: "9C6B2E", size: 22 })],
      })
    );

    const tableRows: TableRow[] = [
      new TableRow({
        children: [
          headerCell("Item", colWidths[0]),
          headerCell("Qty", colWidths[1]),
          headerCell("Unit", colWidths[2]),
          headerCell("Rate", colWidths[3]),
          headerCell("Total", colWidths[4]),
        ],
      }),
      ...rows.map(
        (it) =>
          new TableRow({
            children: [
              bodyCell(it.note ? `${it.name} — ${it.note}` : it.name, colWidths[0]),
              bodyCell(String(it.qty), colWidths[1], AlignmentType.RIGHT),
              bodyCell(it.unit, colWidths[2]),
              bodyCell(it.poa ? "POA" : `$${money(it.rate)}`, colWidths[3], AlignmentType.RIGHT),
              bodyCell(it.poa ? "POA" : `$${money(it.qty * it.rate)}`, colWidths[4], AlignmentType.RIGHT),
            ],
          })
      ),
    ];

    children.push(
      new Table({
        columnWidths: colWidths,
        width: { size: colWidths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
        rows: tableRows,
      })
    );
  });

  if (quote.notes) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 300, after: 120 },
        children: [new TextRun({ text: "Notes & inclusions", bold: true, color: "9C6B2E", size: 22 })],
      })
    );
    quote.notes.split("\n").forEach((line) => {
      children.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: line, size: 18 })] }));
    });
  }

  children.push(
    new Paragraph({ spacing: { before: 300 }, border: { top: { style: "single", size: 6, color: "B9AC94" } }, children: [] }),
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 120 },
      children: [
        new TextRun({ text: "Subtotal: ", color: "6B6053", size: 18 }),
        new TextRun({ text: `$${money(quote.subtotal)}`, size: 18 }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [
        new TextRun({ text: `Markup (${quote.markupPct}%): `, color: "6B6053", size: 18 }),
        new TextRun({ text: `$${money(quote.markupAmount)}`, size: 18 }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 120 },
      children: [
        new TextRun({ text: "Total: ", bold: true, size: 24 }),
        new TextRun({ text: `$${money(quote.total)}`, bold: true, size: 24 }),
      ],
    })
  );

  const doc = new Document({
    sections: [
      {
        properties: { page: { size: { width: 12240, height: 15840 } } }, // US Letter
        children,
      },
    ],
  });

  return Packer.toBlob(doc);
}

export async function downloadQuoteDocx(quote: ExportQuote, filename: string) {
  const blob = await buildQuoteDocx(quote);
  saveAs(blob, filename);
}

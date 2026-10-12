import {
  AlignmentType,
  BorderStyle,
  Document,
  ImageRun,
  Footer,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TabStopType,
  TextRun,
  WidthType,
} from "docx";
import { saveAs } from "file-saver";
import type { ExportQuote } from "./exportPdf";
import { VICELLO_FOOTER_LINES, VICELLO_LOGO_PNG, VICELLO_LOGO_RATIO, VICELLO_MARK_PNG, isVicello } from "./brandAssets";
import { APPROVAL_TEXT, STANDARD_INCLUSIONS, TERMS_SECTIONS, parseTermLine, quoteAreaGroups } from "./quoteTerms";

const INK = "241E17";
const BRASS = "8B7E6E";
const SOFT = "6B6053";
const BAND = "F5F1EB";
const LINE = "DDD5C6";
function b64(s: string) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const W = 10200; // content width (A4, 0.75" margins) in DXA
const FONT = "Arial";

function money(n: number) {
  return n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = { top: none, bottom: none, left: none, right: none };

function run(text: string, o: { bold?: boolean; italics?: boolean; size?: number; color?: string; font?: string; spacing?: number } = {}) {
  return new TextRun({ text, bold: o.bold, italics: o.italics, size: o.size ?? 19, color: o.color ?? INK, font: o.font ?? FONT, characterSpacing: o.spacing });
}

function sectionHeading(title: string) {
  return new Paragraph({
    keepNext: true,
    spacing: { before: 360, after: 160 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: BRASS, space: 4 } },
    children: [run(title.toUpperCase(), { bold: true, size: 17, color: BRASS, spacing: 40 })],
  });
}

function bulletPara(raw: string, size = 18) {
  const t = parseTermLine(raw);
  if (t.kind === "note") {
    return new Paragraph({ spacing: { after: 80 }, children: [run(t.text, { italics: true, size: size - 1, color: SOFT })] });
  }
  return new Paragraph({
    numbering: { reference: "bul", level: 0 },
    spacing: { after: 60 },
    children: [...(t.lead ? [run(t.lead + " ", { bold: true, size })] : []), run(t.text, { size })],
  });
}

function cell(children: Paragraph[], width: number, fill?: string) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: noBorders,
    shading: fill ? { type: ShadingType.CLEAR, fill, color: "auto" } : undefined,
    margins: { top: 70, bottom: 70, left: 120, right: 120 },
    children,
  });
}

function bandRow(num: string, title: string, price: string, hasPoa: boolean) {
  return new Table({
    columnWidths: [700, W - 700 - 2400, 2400],
    width: { size: W, type: WidthType.DXA },
    borders: { top: none, bottom: none, left: { style: BorderStyle.SINGLE, size: 24, color: INK }, right: none, insideHorizontal: none, insideVertical: none },
    rows: [
      new TableRow({
        cantSplit: true,
        children: [
          cell([new Paragraph({ children: [run(num, { size: 17, color: SOFT })] })], 700, BAND),
          cell([new Paragraph({ keepNext: true, children: [run(title, { bold: true, size: 24, font: "Times New Roman" })] })], W - 700 - 2400, BAND),
          cell(
            [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: price
                  ? [run(price, { bold: true, size: 21 }), ...(hasPoa ? [run("  + POA", { bold: true, size: 14, color: BRASS })] : [])]
                  : [run("INCLUDED", { bold: true, size: 15, color: BRASS })],
              }),
            ],
            2400,
            BAND
          ),
        ],
      }),
    ],
  });
}

export async function buildQuoteDocx(quote: ExportQuote): Promise<Blob> {
  const groups = quoteAreaGroups(quote.items);
  const areaPrice = (g: { included: { qty: number; rate: number }[] }) =>
    g.included.reduce((s, it) => s + it.qty * it.rate, 0) * (1 + quote.markupPct / 100);
  const subtotal = quote.total;
  const gst = subtotal * 0.1;

  const kids: (Paragraph | Table)[] = [];

  // Header
  kids.push(
    new Table({
      columnWidths: [W / 2, W / 2],
      width: { size: W, type: WidthType.DXA },
      borders: { top: none, left: none, right: none, insideHorizontal: none, insideVertical: none, bottom: none },
      rows: [
        new TableRow({
          children: [
            cell(
              [
                ...(isVicello(quote.businessName)
                  ? [new Paragraph({ children: [new ImageRun({ type: "png", data: b64(VICELLO_LOGO_PNG), transformation: { width: Math.round(46 * VICELLO_LOGO_RATIO), height: 46 } })] })]
                  : [
                      new Paragraph({ children: [run((quote.businessName || "Business Name").toUpperCase(), { bold: true, size: 32, font: "Times New Roman", spacing: 60 })] }),
                      new Paragraph({ children: [run(quote.businessContact || "", { size: 16, color: SOFT })] }),
                    ]),
              ],
              W / 2
            ),
            cell(
              [
                new Paragraph({ alignment: AlignmentType.RIGHT, children: [run("QUOTATION", { size: 38, color: INK, font: "Times New Roman", spacing: 90 })] }),
                new Paragraph({ alignment: AlignmentType.RIGHT, children: [run([quote.clientName, quote.quoteRef ? `Ref ${quote.quoteRef}` : ""].filter(Boolean).join(" · "), { size: 16, color: SOFT })] }),
              ],
              W / 2
            ),
          ],
        }),
      ],
    }),
    new Paragraph({ spacing: { after: 200 }, children: [] })
  );

  // Details grid
  const det: [string, string, string, string][] = [
    ["Client name", quote.clientName || "—", "Date", quote.quoteDate || "—"],
    ["Site address", quote.jobAddress || "—", "Job #", quote.quoteRef || "—"],
    ["Consultant", quote.builderName || "—", "Valid for", `${quote.validDays} days`],
  ];
  const dw = [1700, 3400, 1500, 3600];
  const hair = { style: BorderStyle.SINGLE, size: 4, color: LINE };
  kids.push(
    new Table({
      columnWidths: dw,
      width: { size: W, type: WidthType.DXA },
      borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
      rows: det.map(
        (r) =>
          new TableRow({
            children: [
              cell([new Paragraph({ children: [run(r[0].toUpperCase(), { bold: true, size: 14, color: SOFT, spacing: 20 })] })], dw[0], BAND),
              cell([new Paragraph({ children: [run(r[1], { size: 19 })] })], dw[1]),
              cell([new Paragraph({ children: [run(r[2].toUpperCase(), { bold: true, size: 14, color: SOFT, spacing: 20 })] })], dw[2], BAND),
              cell([new Paragraph({ children: [run(r[3], { size: 19 })] })], dw[3]),
            ],
          })
      ),
    })
  );

  // Summary
  kids.push(sectionHeading("Quote Summary"));
  const sw = [800, W - 800 - 2600, 2600];
  const sumRows: TableRow[] = [
    new TableRow({
      children: [
        cell([new Paragraph({ children: [run("#", { bold: true, size: 15, color: SOFT })] })], sw[0]),
        cell([new Paragraph({ children: [run("AREA", { bold: true, size: 15, color: SOFT, spacing: 20 })] })], sw[1]),
        cell([new Paragraph({ alignment: AlignmentType.RIGHT, children: [run("PRICE EX GST", { bold: true, size: 15, color: SOFT, spacing: 20 })] })], sw[2]),
      ],
    }),
    new TableRow({
      children: [
        cell([new Paragraph({ children: [run("—", { size: 16, color: SOFT })] })], sw[0]),
        cell([new Paragraph({ children: [run("Standard Inclusions", { size: 20 })] })], sw[1]),
        cell([new Paragraph({ alignment: AlignmentType.RIGHT, children: [run("INCLUDED", { bold: true, size: 15, color: BRASS })] })], sw[2]),
      ],
    }),
    ...groups.map(
      (g, i) =>
        new TableRow({
          children: [
            cell([new Paragraph({ children: [run(String(i + 1).padStart(2, "0"), { size: 16, color: SOFT })] })], sw[0], i % 2 === 0 ? "F8F5EE" : undefined),
            cell([new Paragraph({ children: [run(g.area, { size: 20 })] })], sw[1], i % 2 === 0 ? "F8F5EE" : undefined),
            cell(
              [
                new Paragraph({
                  alignment: AlignmentType.RIGHT,
                  children: [run(`$${money(areaPrice(g))}`, { size: 20 }), ...(g.poa.length ? [run("  + POA", { bold: true, size: 14, color: BRASS })] : [])],
                }),
              ],
              sw[2],
              i % 2 === 0 ? "F8F5EE" : undefined
            ),
          ],
        })
    ),
  ];
  kids.push(
    new Table({
      columnWidths: sw,
      width: { size: W, type: WidthType.DXA },
      borders: { top: { style: BorderStyle.SINGLE, size: 8, color: INK }, bottom: hair, left: none, right: none, insideHorizontal: hair, insideVertical: none },
      rows: sumRows,
    }),
    new Paragraph({
      spacing: { before: 200, after: 40 },
      tabStops: [{ type: TabStopType.RIGHT, position: W }],
      children: [run("Subtotal (ex GST)", { color: SOFT, size: 20 }), run(`\t$${money(subtotal)}`, { bold: true, size: 20 })],
    }),
    new Paragraph({
      spacing: { after: 100 },
      tabStops: [{ type: TabStopType.RIGHT, position: W }],
      children: [run("GST (10%)", { color: SOFT, size: 20 }), run(`\t$${money(gst)}`, { bold: true, size: 20 })],
    }),
    new Table({
      columnWidths: [W - 2800, 2800],
      width: { size: W, type: WidthType.DXA },
      borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
      rows: [
        new TableRow({
          children: [
            cell([new Paragraph({ alignment: AlignmentType.RIGHT, children: [run("Total (inc GST)", { bold: true, size: 22, color: "FFFFFF" })] })], W - 2800, INK),
            cell([new Paragraph({ alignment: AlignmentType.RIGHT, children: [run(`$${money(subtotal + gst)}`, { bold: true, size: 26, color: "FFFFFF" })] })], 2800, INK),
          ],
        }),
      ],
    }),
    new Paragraph({
      spacing: { before: 120 },
      children: [run("All prices are excluding GST unless stated. Items marked POA (price on application) are excluded from the totals and priced separately.", { italics: true, size: 15, color: SOFT })],
    })
  );

  // Scope of works
  kids.push(new Paragraph({ pageBreakBefore: true, children: [] }));
  kids.push(sectionHeading("Scope of Works"));
  kids.push(bandRow("00", "Standard Inclusions", "", false), new Paragraph({ spacing: { after: 80 }, children: [] }));
  STANDARD_INCLUSIONS.forEach((s) => kids.push(bulletPara(s, 19)));
  groups.forEach((g, i) => {
    kids.push(new Paragraph({ spacing: { before: 240 }, children: [] }));
    kids.push(bandRow(String(i + 1).padStart(2, "0"), g.area, `$${money(areaPrice(g))}`, g.poa.length > 0));
    kids.push(new Paragraph({ spacing: { after: 80 }, children: [] }));
    g.included.forEach((it) => kids.push(bulletPara(it.note ? `${it.name} — ${it.note}` : it.name, 19)));
    if (g.poa.length) {
      kids.push(new Paragraph({ spacing: { before: 120, after: 60 }, keepNext: true, children: [run("PRICE ON APPLICATION — NOT INCLUDED IN THE PRICE ABOVE", { bold: true, size: 14, color: BRASS, spacing: 16 })] }));
      g.poa.forEach((it) =>
        kids.push(new Paragraph({ indent: { left: 360 }, spacing: { after: 40 }, children: [run("–  " + (it.note ? `${it.name} — ${it.note}` : it.name), { size: 18, color: SOFT })] }))
      );
    }
  });

  if (quote.notes.trim()) {
    kids.push(sectionHeading("Notes"));
    quote.notes.split("\n").filter((l) => l.trim()).forEach((l) => kids.push(new Paragraph({ spacing: { after: 60 }, children: [run(l, { italics: true, size: 18, color: SOFT })] })));
  }

  // Terms & conditions on every quote
  TERMS_SECTIONS.forEach((sec) => {
    kids.push(sectionHeading(sec.title));
    sec.groups.forEach((g) => {
      if (g.heading) kids.push(new Paragraph({ keepNext: true, spacing: { before: 120, after: 60 }, children: [run(g.heading, { bold: true, size: 19 })] }));
      g.items.forEach((s) => kids.push(bulletPara(s, 18)));
    });
  });

  // Client approval
  kids.push(sectionHeading("Client Approval"));
  kids.push(new Paragraph({ keepNext: true, spacing: { after: 240 }, children: [run(APPROVAL_TEXT, { color: SOFT })] }));
  ["Client name", "Client signature", "Date"].forEach((l) =>
    kids.push(
      new Paragraph({
        keepNext: l !== "Date",
        spacing: { before: 260 },
        tabStops: [{ type: TabStopType.LEFT, position: 2000 }, { type: TabStopType.RIGHT, position: W, leader: "underscore" }],
        children: [run(l.toUpperCase(), { bold: true, size: 15, color: SOFT, spacing: 20 }), run("\t\t")],
      })
    )
  );

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: 19 } } } },
    numbering: {
      config: [
        {
          reference: "bul",
          levels: [{ level: 0, format: "bullet", text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 240 } }, run: { color: BRASS } } }],
        },
      ],
    },
    sections: [
      {
        properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1000, bottom: 1000, left: 853, right: 853 } } },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                border: { top: { style: BorderStyle.SINGLE, size: 4, color: LINE, space: 6 } },
                children: isVicello(quote.businessName)
                  ? [new ImageRun({ type: "png", data: b64(VICELLO_MARK_PNG), transformation: { width: 16, height: 16 } })]
                  : [],
              }),
              ...(isVicello(quote.businessName) ? VICELLO_FOOTER_LINES : [[quote.businessName, quote.businessContact].filter(Boolean).join("  ·  ")]).map(
                (t) => new Paragraph({ alignment: AlignmentType.CENTER, children: [run(t, { size: 14, color: SOFT })] })
              ),
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({ children: [PageNumber.CURRENT], size: 16, color: SOFT, font: FONT }),
                  new TextRun({ text: " / ", size: 16, color: SOFT, font: FONT }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: SOFT, font: FONT }),
                ],
              }),
            ],
          }),
        },
        children: kids,
      },
    ],
  });
  return Packer.toBlob(doc);
}

export async function downloadQuoteDocx(quote: ExportQuote, filename: string) {
  const blob = await buildQuoteDocx(quote);
  saveAs(blob, filename);
}

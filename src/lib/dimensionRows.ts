// Reads the printed dimension strings straight out of a PDF's text layer.
//
// CAD "print to PDF" drawings keep every printed figure as real text with an
// exact position. An elevation's bottom dimension string (e.g. 30 | 400 |
// 1180 | 597 | 22 | 904 | 19 | 411 | 30) is a row of numbers whose sum is
// printed again just below it (3593). Finding that row needs no AI at all, so
// the column WIDTHS are exact and repeatable; only what each column
// contains (base / wall / tall) is left for the AI to look at.

export type TextWord = {
  str: string;
  x: number; // left edge, page units, origin top-left
  y: number; // vertical centre, page units, origin top-left
  w: number; // width
  rotated: boolean;
};

export type DimColumn = {
  width: number;
  x0: number; // fraction of page width (0-1)
  x1: number;
  label: string; // any non-numeric text printed in this column's strip
};

export type DimensionString = {
  page: number;
  overall: number;
  columns: DimColumn[];
};

const NUM = /^\d{1,5}(\.\d+)?$/;

export function findDimensionStrings(words: TextWord[], pageNo: number, pageW: number): DimensionString[] {
  const nums = words
    .filter((t) => !t.rotated && NUM.test(t.str.trim()))
    .map((t) => ({ v: parseFloat(t.str), xc: t.x + t.w / 2, y: t.y, x: t.x, w: t.w }));
  const out: DimensionString[] = [];
  const used = new Set<number>();

  // candidate "overall" figures: any number; the row must sit just above it
  const sortedO = nums.slice().sort((a, b) => b.v - a.v);
  for (const o of sortedO) {
    if (o.v < 300) continue;
    // numbers on a row 4–45 units above this figure
    const rowCands = nums.filter((n) => o.y - n.y >= 3 && o.y - n.y <= 45);
    // group into rows by y
    const rows: (typeof nums)[] = [];
    for (const n of rowCands.sort((a, b) => b.y - a.y)) {
      const r = rows.find((row) => Math.abs(row[0].y - n.y) <= 2.5);
      if (r) r.push(n);
      else rows.push([n]);
    }
    // nearest row first (the dimension string closest above the overall)
    for (const row of rows) {
      row.sort((a, b) => a.xc - b.xc);
      // Every contiguous run that sums to the overall; keep the one centred
      // under/over the overall figure (a stray figure from a neighbouring
      // elevation on the same row can otherwise slide a run sideways).
      let hit: typeof nums | null = null;
      let bestDist = Infinity;
      for (let i = 0; i < row.length; i++) {
        let sum = 0;
        for (let j = i; j < row.length; j++) {
          sum += row[j].v;
          if (j - i >= 2 && Math.abs(sum - o.v) <= 1) {
            const run = row.slice(i, j + 1);
            const left = run[0].x, right = run[run.length - 1].x + run[run.length - 1].w;
            if (o.xc >= left - 20 && o.xc <= right + 20) {
              const d = Math.abs((left + right) / 2 - o.xc);
              if (d < bestDist) {
                bestDist = d;
                hit = run;
              }
            }
          }
          if (sum > o.v + 1) break;
        }
      }
      if (hit) {
        const key = Math.round(hit[0].xc * 10) + ":" + Math.round(hit[0].y);
        const idx = Math.round(hit[0].xc) * 100000 + Math.round(hit[0].y);
        if (used.has(idx)) break;
        used.add(idx);
        void key;
        const rowY = hit[0].y;
        // points per mm from the first/last figure centres
        const first = hit[0], last = hit[hit.length - 1];
        const span = last.xc - first.xc;
        const mmSpan = o.v - first.v / 2 - last.v / 2;
        const s = mmSpan > 0 ? span / mmSpan : 0;
        const textWords = words.filter(
          (t) => !t.rotated && !NUM.test(t.str.trim()) && t.y < rowY - 4 && t.y > rowY - 400
        );
        const columns: DimColumn[] = hit.map((n) => {
          const half = (n.v * s) / 2;
          const x0 = n.xc - half, x1 = n.xc + half;
          const label = textWords
            .filter((t) => t.x + t.w / 2 >= x0 && t.x + t.w / 2 <= x1)
            .sort((a, b) => a.y - b.y || a.x - b.x)
            .map((t) => t.str)
            .join(" ");
          return { width: n.v, x0: x0 / pageW, x1: x1 / pageW, label };
        });
        out.push({ page: pageNo, overall: o.v, columns });
        break;
      }
    }
  }
  return out.sort((a, b) => a.columns[0].x0 - b.columns[0].x0);
}

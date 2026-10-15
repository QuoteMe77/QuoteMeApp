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
  upper?: number; // ADJ/FXD notes printed high up (wall-cabinet zone)
  label: string; // any non-numeric text printed in this column's strip
  // Set by analyseElevations (Archicad-style sheets): what the drawing's own height chain and
  // labels say this column is — "base" | "wall" | "base_wall" | "tall" | "gap".
  detKind?: string;
};

export type DimensionString = {
  page: number;
  overall: number;
  rowY?: number; // y (page units, from top) of the printed segment row
  rowX0?: number; // left / right edge of that row, page units
  rowX1?: number;
  columns: DimColumn[];
  // Vertical extent of the elevation as fractions of the page height, with the
  // real-world height (mm) it represents — from the tall vertical dimension.
  frame?: { top: number; bottom: number; mm: number };
  // Sheet style (Archicad etc.) where the small end figures are end panels that
  // belong to the cabinetry, so they count toward its length.
  keepEnds?: boolean;
  // Bands (tall / base / wall height ranges) worked out from the printed height chain.
  det?: { floor: number; k: number; bands: { kind: "base" | "wall" | "tall"; lo: number; hi: number }[]; printed?: { wall?: number } };
};

const NUM = /^\d{1,5}(\.\d+)?$/;
// "1,166" -> "1166" (thousands comma as printed by Archicad etc.)
export function normaliseFigure(str: string) {
  let t = str.trim();
  t = t.replace(/\s*\(COS\)$/i, ""); // "3,040 (COS)" = confirm on site, still a figure
  return /^\d{1,2},\d{3}(\.\d+)?$/.test(t) ? t.replace(",", "") : t;
}

export function findDimensionStrings(words: TextWord[], pageNo: number, pageW: number, pageH = 0, tol = 1): DimensionString[] {
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
    // Two drafting styles: the segment row sits ABOVE the overall (drawing above it,
    // e.g. Vicello CAD) or BELOW it (drawing below it, e.g. Archicad sheets).
    for (const dir of [1, -1] as const) {
    const rowCands = nums.filter((n) => dir * (o.y - n.y) >= 3 && dir * (o.y - n.y) <= 45);
    // group into rows by y
    const rows: (typeof nums)[] = [];
    for (const n of rowCands.sort((a, b) => dir * (b.y - a.y))) {
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
      let hitSum = 0;
      let bestDist = Infinity;
      for (let i = 0; i < row.length; i++) {
        let sum = 0;
        for (let j = i; j < row.length; j++) {
          sum += row[j].v;
          if (j - i >= 2 && Math.abs(sum - o.v) <= tol) {
            const run = row.slice(i, j + 1);
            const left = run[0].x, right = run[run.length - 1].x + run[run.length - 1].w;
            if (o.xc >= left - 20 && o.xc <= right + 20) {
              const d = Math.abs((left + right) / 2 - o.xc) + Math.abs(sum - o.v) * 40;
              if (d < bestDist) {
                bestDist = d;
                hit = run;
                hitSum = sum;
              }
            }
          }
          if (sum > o.v + tol) break;
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
          (t) =>
            !t.rotated && !NUM.test(t.str.trim()) &&
            (dir === 1 ? t.y < rowY - 4 && t.y > rowY - 400 : t.y > rowY + 4 && t.y < rowY + 400)
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
        // Elevation height: the tallest vertical (rotated) dimension in 1.8-3.6m
        // beside this elevation is centred on it, so the top and floor follow.
        let frame: DimensionString["frame"] = undefined;
        if (pageH > 0 && s > 0) {
          const minX = first.x - 90, maxX = last.x + last.w + 90;
          const cands = words.filter(
            (t) => t.rotated && NUM.test(t.str.trim()) && parseFloat(t.str) >= 1800 && parseFloat(t.str) <= 3600 &&
              t.x >= minX && t.x <= maxX && (dir === 1 ? t.y > rowY - 330 && t.y < rowY + 5 : t.y > rowY - 5 && t.y < rowY + 330)
          );
          if (cands.length > 0) {
            const best = cands.reduce((b, t) => (parseFloat(t.str) > parseFloat(b.str) ? t : b), cands[0]);
            const mm = parseFloat(best.str);
            const half = (mm * s) / 2;
            frame = { top: (best.y - half) / pageH, bottom: (best.y + half) / pageH, mm };
          }
        }
        if (frame && s > 0) {
          const limitY = frame.bottom * pageH - 1500 * s;
          hit.forEach((n, i) => {
            const half = (n.v * s) / 2;
            const x0 = n.xc - half, x1 = n.xc + half;
            columns[i].upper = textWords.filter(
              (t) => /^(ADJ|FXD)$/.test(t.str.trim().toUpperCase()) && t.x + t.w / 2 >= x0 && t.x + t.w / 2 <= x1 && t.y < limitY
            ).length;
          });
        }
        // Plan views and section strips also have segment rows; an elevation is the
        // one with a tall vertical (height) dimension beside it, so that's required
        // for the "row below the overall" style.
        if (dir === -1 && !frame) break;
        // A loose match (Archicad sheets whose printed segments fall a few mm short of the overall)
        // takes the segments' own sum as the overall so the columns still check out.
        out.push({ page: pageNo, overall: Math.abs(hitSum - o.v) > 1 ? hitSum : o.v, columns, frame, rowY, rowX0: first.x, rowX1: last.x + last.w });
        break;
      }
    }
    if (out.length > 0 && out[out.length - 1].overall === o.v && dir === 1) break;
    }
  }
  // Rows where some segments are printed as "EQ." (equal share of what's left).
  const eqs = words
    .filter((t) => !t.rotated && /^EQ\.?$/i.test(t.str.trim()))
    .map((t) => ({ v: 0, xc: t.x + t.w / 2, y: t.y, x: t.x, w: t.w, eq: true }));
  if (eqs.length > 0) {
    const fixed = nums.map((n) => ({ ...n, eq: false }));
    for (const o of sortedO) {
      if (o.v < 300) continue;
      // A second view of the same unit on the sheet (internal elevation) has the same
      // overall — count the unit once.
      if (out.some((d) => d.overall === o.v)) continue;
      let done = false;
      for (const dir of [1, -1] as const) {
        if (done) break;
        const cands = [...fixed, ...eqs].filter((n) => dir * (o.y - n.y) >= 3 && dir * (o.y - n.y) <= 45);
        const rows: (typeof cands)[] = [];
        for (const n of cands.sort((a, b) => dir * (b.y - a.y))) {
          const r = rows.find((row) => Math.abs(row[0].y - n.y) <= 2.5);
          if (r) r.push(n);
          else rows.push([n]);
        }
        for (const row of rows) {
          row.sort((a, b) => a.xc - b.xc);
          for (let i = 0; i < row.length && !done; i++) {
            if (row[i].eq) continue;
            for (let j = row.length - 1; j > i + 1 && !done; j--) {
              if (row[j].eq) continue;
              const run = row.slice(i, j + 1);
              const k = run.filter((t) => t.eq).length;
              const fixedSum = run.reduce((a, t) => a + t.v, 0);
              if (k < 1 || fixedSum >= o.v - 1) continue;
              const left = run[0].x, right = run[run.length - 1].x + run[run.length - 1].w;
              if (o.xc < left - 20 || o.xc > right + 20 || Math.abs((left + right) / 2 - o.xc) > 40) continue;
              const first = run[0], last = run[run.length - 1];
              const sc = (last.xc - first.xc) / (o.v - first.v / 2 - last.v / 2);
              if (!(sc > 0)) continue;
              const eqW = (o.v - fixedSum) / k;
              const widths = run.map((t) => (t.eq ? eqW : t.v));
              // Run must really span the overall (its first/last figures sit at the ends).
              const rowY = first.y;
              const textWords = words.filter(
                (t) =>
                  !t.rotated && !NUM.test(t.str.trim()) && !/^EQ\.?$/i.test(t.str.trim()) &&
                  (dir === 1 ? t.y < rowY - 4 && t.y > rowY - 400 : t.y > rowY + 4 && t.y < rowY + 400)
              );
              let cursor = first.xc - (first.v * sc) / 2;
              const columns: DimColumn[] = widths.map((w) => {
                const x0 = cursor, x1 = cursor + w * sc;
                cursor = x1;
                const label = textWords
                  .filter((t) => t.x + t.w / 2 >= x0 && t.x + t.w / 2 <= x1)
                  .sort((a, b) => a.y - b.y || a.x - b.x)
                  .map((t) => t.str)
                  .join(" ");
                return { width: Math.round(w * 10) / 10, x0: x0 / pageW, x1: x1 / pageW, label };
              });
              // Every printed figure / "EQ." must sit over its own computed column.
              const aligned = run.every((t, idx) => {
                const c = columns[idx];
                const cx = ((c.x0 + c.x1) / 2) * pageW;
                return Math.abs(cx - t.xc) <= Math.max(10, ((c.x1 - c.x0) * pageW) * 0.2);
              });
              if (!aligned) continue;
              let frame: DimensionString["frame"] = undefined;
              if (pageH > 0) {
                const minX = first.x - 90, maxX = last.x + last.w + 90;
                const fc = words.filter(
                  (t) => t.rotated && NUM.test(t.str.trim()) && parseFloat(t.str) >= 1800 && parseFloat(t.str) <= 3600 &&
                    t.x >= minX && t.x <= maxX && (dir === 1 ? t.y > rowY - 330 && t.y < rowY + 5 : t.y > rowY - 5 && t.y < rowY + 330)
                );
                if (fc.length > 0) {
                  const best = fc.reduce((b, t) => (parseFloat(t.str) > parseFloat(b.str) ? t : b), fc[0]);
                  const mm = parseFloat(best.str);
                  const half = (mm * sc) / 2;
                  frame = { top: (best.y - half) / pageH, bottom: (best.y + half) / pageH, mm };
                }
              }
              if (frame && (frame.top < 0 || frame.bottom > 1)) continue;
              if (dir === -1 && !frame) continue;
              out.push({ page: pageNo, overall: o.v, columns, frame });
              done = true;
            }
          }
        }
      }
    }
  }
  return out.sort((a, b) => a.columns[0].x0 - b.columns[0].x0);
}

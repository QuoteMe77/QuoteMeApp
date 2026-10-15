// Works out, straight from a CAD PDF's own text, WHAT each elevation is made of — without
// asking the AI to look at a picture.
//
// Archicad-style joinery sheets (ORK etc.) print a vertical "height chain" beside every
// elevation (e.g. 100 | 2400 | 20 | 410 | 20 for a wardrobe, 280 | 400 | 20 | 200 | 250 |
// 1250 | 640 for a vanity) and label what is drawn on it (L2 laminate tags, DRAWER, ADJ
// shelves, JH hardware codes ...) while things that are NOT joinery carry other codes
// (WP/WF wall finish, ST stone, FT fixture, WL light ...). Putting those together tells us
// which height bands hold cabinets and which are blank wall:
//   cabinets from the floor right up to the ceiling      -> TALL
//   cabinets on the floor, stopping below ~1.8m          -> BASE
//   cabinets that start above the bench gap              -> WALL
// and, per column, which of those bands the column really has.

import type { DimensionString, TextWord } from "./dimensionRows";

export type Band = { kind: "base" | "wall" | "tall"; lo: number; hi: number };

export type ElevationDet = {
  // Floor line and scale as fractions of the page height (fraction per mm).
  floor: number;
  k: number;
  bands: Band[];
  // When a printed segment (e.g. the shaving cabinet's 1,339) matches the columns it covers,
  // the printed figure is used rather than the columns' rounded sum.
  printed?: { wall?: number };
};

const NUM = /^\d{1,5}(\.\d+)?$/;

// Text that appears ON joinery fronts / inside carcases.
const POS = /^(L\d{1,2}|MR\d{0,2}|ADJ|FXD|JH\w*|DRAWER|INNER DRAWER|FIX SH|FIX|SH|FIXED|PANEL|HANG\w*|ROD|PTO|SHELF|SHELVES)$/;
// Text that marks something that is NOT joinery sitting in that zone.
const NEG = /^(WP\d*|WF\d*|WT\d*|ST\d+|FT\d+|ZETR\d*|WL\d*|LED\d*|TM\d+|AP\d*|FB\d*|GPO|PWR)$/;

// Appliances / fittings that make a sheet a mixed layout (tall columns beside base runs etc.),
// which a single height chain can't describe — leave those to the AI.
const MIXED = /FRIDGE|FREEZER|DISHWASHER|DISH DRAWER|DRYER|WASHING|OVEN|COOKTOP|MICROWAVE|SINK|BROOM|IRONING|HAMPER|BASKET|\bBIN\b|BENCH SEAT|SEAT PAD/;

const up = (s: string) => s.trim().toUpperCase();

function median(a: number[]) {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

type Tok = { v: number; x: number; y: number };

// Annotates each elevation string (in place) with `det` and per-column `detKind`.
// Only Archicad-style sheets are touched (the caller sets keepEnds on those).
export function analyseElevations(words: TextWord[], strings: DimensionString[], pageW: number, pageH: number) {
  if (strings.length === 0 || pageW <= 0 || pageH <= 0) return;
  const rot: Tok[] = words
    .filter((t) => t.rotated && NUM.test(t.str.trim()))
    .map((t) => ({ v: parseFloat(t.str), x: t.x, y: t.y }));
  const flat = words.filter((t) => !t.rotated);
  const flatNums = flat
    .filter((t) => NUM.test(t.str.trim()))
    .map((t) => ({ v: parseFloat(t.str), xc: t.x + t.w / 2, y: t.y, x: t.x, w: t.w }));
  const textToks = flat
    .filter((t) => !NUM.test(t.str.trim()))
    .map((t) => ({ s: up(t.str), x: t.x, xc: t.x + t.w / 2, y: t.y, w: t.w }));

  for (const str of strings) {
    if (!str.keepEnds || !str.frame || str.columns.length < 3) continue;
    const cols = str.columns;
    const X0 = cols[0].x0 * pageW;
    const X1 = cols[cols.length - 1].x1 * pageW;
    const s = (X1 - X0) / str.overall; // page points per mm
    if (!(s > 0)) continue;
    const frameMm = str.frame.mm;

    // --- the vertical height chain beside this elevation ---------------------------------
    const near = rot.filter(
      (t) => t.v >= 10 && t.v <= 3600 && t.x >= X0 - 0.09 * pageW && t.x <= X1 + 0.1 * pageW &&
        t.y >= (str.frame!.top - 0.06) * pageH && t.y <= (str.frame!.bottom + 0.06) * pageH
    );
    const byX = near.slice().sort((a, b) => a.x - b.x);
    const groups: Tok[][] = [];
    for (const t of byX) {
      const g = groups[groups.length - 1];
      if (g && t.x - g[g.length - 1].x <= 0.008 * pageW) g.push(t);
      else groups.push([t]);
    }
    type Chain = { toks: Tok[]; sum: number; dist: number };
    const chains: Chain[] = groups
      .filter((g) => g.length >= 3)
      .map((g) => {
        const toks = g.slice().sort((a, b) => a.y - b.y);
        const sum = toks.reduce((a, t) => a + t.v, 0);
        const cx = g.reduce((a, t) => a + t.x, 0) / g.length;
        const dist = cx < X0 ? X0 - cx : cx > X1 ? cx - X1 : 0;
        return { toks, sum, dist };
      })
      .filter((c) => c.sum >= frameMm * 0.9 && c.sum <= Math.max(frameMm * 1.03, 3300));
    if (chains.length === 0) continue;
    chains.sort((a, b) => a.dist - b.dist);
    const chain = chains[0];

    // segments bottom -> top with mm-from-floor ranges, and the floor line from their labels
    const segsTopDown = chain.toks;
    const segs: { v: number; lo: number; hi: number; yc: number }[] = [];
    let cum = 0;
    for (let i = segsTopDown.length - 1; i >= 0; i--) {
      const t = segsTopDown[i];
      segs.push({ v: t.v, lo: cum, hi: cum + t.v, yc: t.y });
      cum += t.v;
    }
    const floorEst = segs.filter((g) => g.v >= 150).map((g) => g.yc + ((g.lo + g.hi) / 2) * s);
    if (floorEst.length < 2) continue;
    const floorY = median(floorEst);
    if (Math.max(...floorEst) - Math.min(...floorEst) > 14) continue; // labels don't sit where the chain says

    // --- evidence tokens inside the elevation ---------------------------------------------
    const toks = textToks
      .filter((t) => t.xc >= X0 - 4 && t.xc <= X1 + 4)
      .map((t) => ({ ...t, mm: (floorY - t.y) / s, pos: POS.test(t.s), neg: NEG.test(t.s) }))
      .filter((t) => t.mm >= -50 && t.mm <= frameMm + 50 && (t.pos || t.neg));
    const evidenceIn = (lo: number, hi: number, xa = -Infinity, xb = Infinity) => {
      let pos = 0, neg = 0;
      for (const t of toks) {
        if (t.mm < lo || t.mm > hi || t.xc < xa || t.xc > xb) continue;
        if (t.pos) pos++;
        else if (t.neg) neg++;
      }
      return { pos, neg };
    };

    // Mixed layouts (appliances, a tall column beside a base run) are not described by one height chain.
    const elevTopY = floorY - (segs[segs.length - 1].hi + 120) * s;
    if (textToks.some((t) => t.xc >= X0 && t.xc <= X1 && t.y >= elevTopY && t.y <= floorY + 30 && MIXED.test(t.s))) continue;

    // --- which segments hold cabinets, merged into bands ---------------------------------
    type Seg = (typeof segs)[number] & { cab: boolean; big: boolean };
    const classified: Seg[] = segs.map((g) => ({ ...g, big: g.v >= 150, cab: g.v >= 150 && evidenceIn(g.lo, g.hi).pos > 0 }));
    const ranges: { lo: number; hi: number }[] = [];
    for (const g of classified) {
      if (!g.cab) continue;
      const last = ranges[ranges.length - 1];
      if (last && g.lo - last.hi <= 150) last.hi = g.hi;
      else ranges.push({ lo: g.lo, hi: g.hi });
    }
    if (ranges.length === 0) continue;
    // a kick / small neutral piece right at the floor belongs to the lowest band
    if (ranges[0].lo <= 200) ranges[0].lo = 0;
    const top = classified.length ? classified[classified.length - 1].hi : frameMm;
    const bands: Band[] = ranges.map((r) => {
      const hi = r.hi >= top - 160 ? top : r.hi; // small top pieces (shadowline, cornice) join the band
      return { lo: r.lo, hi, kind: r.lo < 400 ? (hi >= 1800 ? "tall" : "base") : "wall" };
    });

    // --- a distinct row of segment figures ABOVE the elevation (e.g. 1,339 | 551) ---------
    const elevTop = floorY - top * s;
    const rowCands = flatNums.filter(
      (n) => n.y < elevTop - 4 && n.y > elevTop - 150 && n.xc >= X0 - 40 && n.xc <= X1 + 40 && n.v >= 20
    );
    const rows: (typeof flatNums)[] = [];
    for (const n of rowCands.sort((a, b) => b.y - a.y)) {
      const r = rows.find((row) => Math.abs(row[0].y - n.y) <= 2.5);
      if (r) r.push(n);
      else rows.push([n]);
    }
    const topRow = rows.find((r) => r.length >= 2);
    let topSegs: { v: number; xa: number; xb: number }[] = [];
    if (topRow) {
      topRow.sort((a, b) => a.xc - b.xc);
      const sameAsColumns =
        topRow.length === cols.length && topRow.every((n, i) => Math.abs(n.v - cols[i].width) <= 1);
      if (!sameAsColumns) topSegs = topRow.map((n) => ({ v: n.v, xa: n.xc - (n.v * s) / 2, xb: n.xc + (n.v * s) / 2 }));
    }

    // Every column must agree about each height segment: if one column has joinery where
    // another has an explicit non-joinery item (wall finish, stone ...), the columns are
    // different kinds of unit and one chain can't describe them (a wall-cabinet run narrower
    // than the base run is described by the segment row above, so that band is exempt).
    let conflict = false;
    for (const g of classified) {
      if (!g.big) continue;
      const inWallBandWithTop = topSegs.length > 0 && bands.some((b) => b.kind === "wall" && g.lo >= b.lo - 1 && g.hi <= b.hi + 1);
      if (inWallBandWithTop) continue;
      let cab = false, blank = false;
      for (const c of cols) {
        if (c.width < 60) continue;
        const ev = evidenceIn(g.lo, g.hi, c.x0 * pageW, c.x1 * pageW);
        if (ev.pos > 0) cab = true;
        else if (ev.neg > 0) blank = true;
      }
      if (cab && blank) conflict = true;
    }
    if (conflict) continue;

    // --- per-column membership -------------------------------------------------------------
    const kinds = cols.map(() => ({ base: false, wall: false, tall: false }));
    let printedWall: number | undefined;
    for (const b of bands) {
      const hasTop = b.kind === "wall" && topSegs.length > 0;
      const segOk = hasTop
        ? topSegs.map((g) => {
            const ev = evidenceIn(b.lo, b.hi, g.xa, g.xb);
            return ev.pos > 0 || ev.neg === 0;
          })
        : [];
      const memberCols: number[] = [];
      cols.forEach((c, i) => {
        if (c.width < 60) return;
        const xa = c.x0 * pageW;
        const xb = c.x1 * pageW;
        let inc: boolean;
        if (hasTop) {
          inc = topSegs.some((g, gi) => segOk[gi] && Math.min(xb, g.xb) - Math.max(xa, g.xa) >= 0.5 * (xb - xa));
        } else {
          const ev = evidenceIn(b.lo, b.hi, xa, xb);
          inc = !(ev.neg > 0 && ev.pos === 0);
        }
        if (inc) {
          kinds[i][b.kind] = true;
          memberCols.push(i);
        }
      });
      if (hasTop && memberCols.length > 0) {
        const colSum = memberCols.reduce((a, i) => a + cols[i].width, 0);
        const incSegs = topSegs.filter((_, gi) => segOk[gi]);
        const printed = incSegs.reduce((a, g) => a + g.v, 0);
        if (incSegs.length === 1 && Math.abs(printed - colSum) <= 3) printedWall = printed;
      }
    }
    cols.forEach((c, i) => {
      const k = kinds[i];
      c.detKind = c.width < 60 ? "gap" : k.tall ? "tall" : k.base && k.wall ? "base_wall" : k.base ? "base" : k.wall ? "wall" : "gap";
    });
    str.det = { floor: floorY / pageH, k: s / pageH, bands, printed: printedWall ? { wall: printedWall } : undefined };
  }
}

export type DrawerView = { page: number; count: number; bbox: [number, number, number, number] };

// Counts the drawers drawn on a sheet from their printed labels, inside the ELEVATION
// views only (a plan view or a side section repeats the same drawers and must not add to
// the count). An "INNER DRAWER" sits inside a drawer, so each one stands for two.
export function findDrawerView(words: TextWord[], pageNo: number, pageW: number, pageH: number): DrawerView | null {
  const flat = words.filter((t) => !t.rotated).map((t) => ({ s: up(t.str), x: t.x, xc: t.x + t.w / 2, y: t.y, w: t.w }));
  const titles = flat
    .map((t) => ({ ...t, m: /^[A-Z]\d{1,2}:\s*(.+)$/.exec(t.s) }))
    .filter((t) => t.m)
    .map((t) => ({ x: t.x, y: t.y, kind: /ELEVATION/.test(t.m![1]) ? "elev" : /SECTION/.test(t.m![1]) ? "section" : /PLAN/.test(t.m![1]) ? "plan" : "other" }));
  const elevs = titles.filter((t) => t.kind === "elev");
  if (elevs.length === 0) return null;
  const tokens = flat.filter((t) => /^(INNER )?DRAWER$/.test(t.s));
  let best: DrawerView | null = null;
  for (const e of elevs) {
    const left = e.x - 0.03 * pageW;
    // next title on the same row bounds this view on the right
    const nextX = titles
      .filter((t) => t !== e && Math.abs(t.y - e.y) < 0.03 * pageH && t.x > e.x + 10)
      .reduce((m, t) => Math.min(m, t.x - 0.03 * pageW), pageW * 0.99);
    const inView = tokens.filter((t) => t.xc >= left && t.xc <= nextX && t.y <= e.y && t.y >= e.y - 0.45 * pageH);
    if (inView.length === 0) continue;
    const inner = inView.filter((t) => t.s === "INNER DRAWER").length;
    const plain = inView.length - inner;
    const count = Math.max(plain + inner, inner * 2);
    if (best && best.count >= count) continue;
    const x0 = Math.min(...inView.map((t) => t.x)) - 10;
    const x1 = Math.max(...inView.map((t) => t.x + t.w)) + 10;
    const y0 = Math.min(...inView.map((t) => t.y)) - 16;
    const y1 = Math.max(...inView.map((t) => t.y)) + 16;
    const c = (n: number) => Math.min(1, Math.max(0, n));
    best = { page: pageNo, count, bbox: [c(x0 / pageW), c(y0 / pageH), c(x1 / pageW), c(y1 / pageH)] };
  }
  return best;
}

// Archicad sheets title every view ("E01: FRONT ELEVATION", "E02: SIDE ELEVATION", "SECTION"...) just
// below it. A dimension string whose nearest title below is a side elevation, section or plan is a
// different view of the same joinery, not another run of cabinets — it is dropped.
export function dropNonFrontViews(words: TextWord[], strings: DimensionString[]): DimensionString[] {
  const titles = words.filter((w) => /^[A-Z]\d{1,2}:\s*\S/.test(w.str.trim()) && !w.rotated);
  if (titles.length === 0) return strings;
  return strings.filter((d) => {
    if (typeof d.rowY !== "number" || typeof d.rowX0 !== "number" || typeof d.rowX1 !== "number") return true;
    const below = titles
      .filter((t) => t.y > d.rowY! && t.x <= d.rowX1! + 30 && t.x + t.w >= d.rowX0! - 30)
      .sort((a, b) => a.y - b.y)[0];
    if (!below) return true;
    return !/\b(SIDE\s+ELEVATION|SECTION|PLAN)\b/i.test(below.str) || /\bELEVATIONS?\b/i.test(below.str) && !/SIDE|SECTION/i.test(below.str);
  });
}

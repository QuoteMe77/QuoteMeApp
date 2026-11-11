// Splits quote cost into departments using each price book row's breakdown.
export type CostKey = "cost_material" | "cost_hardware" | "cost_factory" | "cost_drafting" | "cost_studio" | "cost_install";

export const COST_DEPTS: { key: CostKey; label: string }[] = [
  { key: "cost_material", label: "Material" },
  { key: "cost_hardware", label: "Hardware" },
  { key: "cost_factory", label: "Factory" },
  { key: "cost_drafting", label: "Drafting" },
  { key: "cost_studio", label: "Studio" },
  { key: "cost_install", label: "Install" },
];

export type PbCost = {
  id: string;
  cost_material?: number | null;
  cost_hardware?: number | null;
  cost_factory?: number | null;
  cost_drafting?: number | null;
  cost_studio?: number | null;
  cost_install?: number | null;
  cost_estimated?: boolean | null;
};

export type CostItem = {
  price_book_item_id: string | null;
  name: string;
  area: string;
  qty: number;
  rate: number;
  poa: boolean;
};

export type RoomCost = { depts: Record<string, number>; unalloc: number; total: number; profit: number };
export type CostView = {
  depts: Record<string, number>;
  unallocated: number;
  estimated: number;
  missing: { name: string; area: string; cost: number }[];
  rooms: [string, RoomCost][];
};

const zero = () => {
  const o: Record<string, number> = {};
  COST_DEPTS.forEach((d) => (o[d.key] = 0));
  return o;
};

export function computeCostBreakdown(items: CostItem[], priceBook: PbCost[], markupPct = 0, roomPrefix = ""): CostView {
  const byId = new Map(priceBook.map((p) => [p.id, p]));
  const depts = zero();
  let unallocated = 0;
  let estimated = 0;
  const missing: CostView["missing"] = [];
  const rooms = new Map<string, RoomCost>();
  for (const it of items) {
    if (it.poa) continue;
    const lineCost = it.qty * it.rate;
    const area = `${roomPrefix}${it.area || "General"}`;
    if (!rooms.has(area)) rooms.set(area, { depts: zero(), unalloc: 0, total: 0, profit: 0 });
    const room = rooms.get(area)!;
    room.total += lineCost;
    room.profit += lineCost * (markupPct / 100);
    const pb = it.price_book_item_id ? byId.get(it.price_book_item_id) : undefined;
    const parts = pb ? COST_DEPTS.map((d) => Number(pb[d.key]) || 0) : [];
    const sum = parts.reduce((a, b) => a + b, 0);
    if (!pb || sum <= 0) {
      unallocated += lineCost;
      room.unalloc += lineCost;
      if (Math.abs(lineCost) > 0.005) missing.push({ name: it.name, area, cost: lineCost });
      continue;
    }
    if (pb.cost_estimated) estimated += lineCost;
    COST_DEPTS.forEach((d, i) => {
      const part = lineCost * (parts[i] / sum);
      depts[d.key] += part;
      room.depts[d.key] += part;
    });
  }
  return { depts, unallocated, estimated, missing, rooms: Array.from(rooms.entries()) };
}

export function mergeCostViews(views: CostView[]): CostView {
  const depts = zero();
  let unallocated = 0;
  let estimated = 0;
  const missing: CostView["missing"] = [];
  const rooms: [string, RoomCost][] = [];
  for (const v of views) {
    COST_DEPTS.forEach((d) => (depts[d.key] += v.depts[d.key]));
    unallocated += v.unallocated;
    estimated += v.estimated;
    missing.push(...v.missing);
    rooms.push(...v.rooms);
  }
  return { depts, unallocated, estimated, missing, rooms };
}

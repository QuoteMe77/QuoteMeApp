"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import NoCopy from "@/components/NoCopy";
import { addPriceBookItem, bulkAdjustRates, deletePriceBookItem, updatePriceBookItem } from "../actions";

type Item = {
  id: string;
  calc: "LM" | "QTY" | "MISC";
  section: string;
  category: string;
  name: string;
  rate: number;
  unit: string;
  cost_material?: number | null;
  cost_hardware?: number | null;
  cost_factory?: number | null;
  cost_drafting?: number | null;
  cost_studio?: number | null;
  cost_install?: number | null;
  cost_estimated?: boolean | null;
};

const SPLITS = [
  { key: "cost_material", label: "Material" },
  { key: "cost_hardware", label: "Hardware" },
  { key: "cost_factory", label: "Factory" },
  { key: "cost_drafting", label: "Drafting" },
  { key: "cost_studio", label: "Studio" },
  { key: "cost_install", label: "Install" },
] as const;

type SplitKey = (typeof SPLITS)[number]["key"];

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));

export default function PriceBookEditor({ items }: { items: Item[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [pct, setPct] = useState("");

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, Item[]>();
    for (const it of items) {
      if (q && !`${it.name} ${it.category} ${it.section}`.toLowerCase().includes(q)) continue;
      if (!map.has(it.section)) map.set(it.section, []);
      map.get(it.section)!.push(it);
    }
    return Array.from(map.entries());
  }, [items, query]);

  const allSections = useMemo(() => Array.from(new Set(items.map((i) => i.section))), [items]);
  const allCategories = useMemo(() => Array.from(new Set(items.map((i) => i.category))), [items]);

  function flash(kind: "ok" | "err", text: string) {
    setMsg({ kind, text });
    if (kind === "ok") setTimeout(() => setMsg((m) => (m && m.text === text ? null : m)), 2500);
  }

  async function save(id: string, patch: Record<string, unknown>) {
    const r = await updatePriceBookItem(id, patch);
    if ("error" in r) flash("err", r.error);
    else {
      flash("ok", "Saved");
      startTransition(() => router.refresh());
    }
  }

  async function remove(it: Item) {
    if (!window.confirm(`Delete "${it.name}" from your price book? Quotes already saved keep their price, but you won't be able to add this item again.`)) return;
    const r = await deletePriceBookItem(it.id);
    if ("error" in r) flash("err", r.error);
    else {
      flash("ok", "Deleted");
      startTransition(() => router.refresh());
    }
  }

  async function bulk() {
    const p = Number(pct);
    if (!pct || !Number.isFinite(p) || p === 0) {
      flash("err", "Type a percentage first, e.g. 5 to raise everything by 5%.");
      return;
    }
    if (!window.confirm(`${p > 0 ? "Raise" : "Lower"} EVERY rate and cost split in your price book by ${Math.abs(p)}%? This changes all ${items.length} items.`)) return;
    const r = await bulkAdjustRates(p);
    if ("error" in r) flash("err", r.error);
    else {
      flash("ok", `${r.changed} items updated`);
      setPct("");
      startTransition(() => router.refresh());
    }
  }

  return (
    <NoCopy>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input
          className="border border-line-strong rounded-md px-3 py-2 text-base bg-white w-72"
          placeholder="Search your price book…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button onClick={() => setAdding((v) => !v)} className="bg-brass hover:bg-brass-deep text-white rounded-md px-4 py-2 text-base font-semibold">
          {adding ? "Close" : "+ Add new item"}
        </button>
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-sm text-ink-soft">Price rise</span>
          <input
            className="border border-line-strong rounded-md px-2 py-2 text-base bg-white w-20 text-right"
            placeholder="5"
            inputMode="decimal"
            value={pct}
            onChange={(e) => setPct(e.target.value)}
          />
          <span className="text-sm text-ink-soft">%</span>
          <button onClick={bulk} className="border border-line-strong rounded-md px-3 py-2 text-base hover:bg-white">
            Apply to all
          </button>
        </div>
      </div>

      {msg && (
        <div className={`mb-3 rounded-md px-4 py-2 text-sm ${msg.kind === "ok" ? "bg-green-50 text-spruce border border-green-200" : "bg-red-50 text-brick border border-red-200"}`}>
          {msg.text}
        </div>
      )}

      <p className="text-sm text-ink-soft mb-4">
        The <b>rate</b> is your all-in cost for the item. The six columns on the right say where that cost goes, so the cost
        breakdown on each job is accurate. They should add up to the rate. Markup is added on top when you quote.
      </p>

      {adding && (
        <AddForm
          sections={allSections}
          categories={allCategories}
          onDone={(text) => {
            flash("ok", text);
            setAdding(false);
            startTransition(() => router.refresh());
          }}
          onError={(t) => flash("err", t)}
        />
      )}

      {sections.length === 0 && <p className="text-ink-soft">No items match.</p>}

      {sections.map(([section, rows]) => (
        <details key={section} open={!!query || sections.length === 1} className="mb-4 bg-paper-raised border border-line-strong rounded-lg">
          <summary className="cursor-pointer px-4 py-3 font-display text-lg font-semibold flex items-center justify-between">
            <span>{section}</span>
            <span className="text-sm font-normal text-ink-soft">{rows.length} items</span>
          </summary>
          <div className="overflow-x-auto px-2 pb-3">
            <table className="w-full text-sm min-w-[1100px]">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-soft">
                  <th className="px-2 py-2 font-medium">Item</th>
                  <th className="px-2 py-2 font-medium w-14">Unit</th>
                  <th className="px-2 py-2 font-medium w-24 text-right">Rate</th>
                  {SPLITS.map((s) => (
                    <th key={s.key} className="px-1 py-2 font-medium w-[76px] text-right">
                      {s.label}
                    </th>
                  ))}
                  <th className="px-2 py-2 font-medium w-28">Split check</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {rows.map((it) => (
                  <Row key={`${it.id}:${it.rate}:${SPLITS.map((s) => fmt(it[s.key])).join(",")}:${it.name}:${it.unit}`} it={it} onSave={save} onDelete={remove} />
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
    </NoCopy>
  );
}

function Row({ it, onSave, onDelete }: { it: Item; onSave: (id: string, patch: Record<string, unknown>) => void; onDelete: (it: Item) => void }) {
  const [vals, setVals] = useState<Record<string, string>>({
    name: it.name,
    unit: it.unit,
    rate: fmt(it.rate),
    ...Object.fromEntries(SPLITS.map((s) => [s.key, fmt(it[s.key])])),
  });
  const splitSum = SPLITS.reduce((a, s) => a + (Number(vals[s.key]) || 0), 0);
  const anySplit = SPLITS.some((s) => vals[s.key] !== "");
  const rate = Number(vals.rate) || 0;
  const diff = Math.round((rate - splitSum) * 100) / 100;

  function commit(key: string, original: string | number | null | undefined) {
    if (vals[key] === fmt(original as number)) return;
    onSave(it.id, { [key]: vals[key] });
  }
  const cell = "w-full border border-transparent hover:border-line-strong focus:border-brass rounded px-1.5 py-1 bg-transparent focus:bg-white text-sm";

  return (
    <tr className="border-t border-line align-middle">
      <td className="px-1 py-1">
        <input className={cell} value={vals.name} onChange={(e) => setVals({ ...vals, name: e.target.value })} onBlur={() => commit("name", it.name)} />
        <div className="px-1.5 text-[11px] text-ink-soft">
          {it.category} · {it.calc === "LM" ? "per lineal metre" : it.calc === "QTY" ? "each" : "misc"}
        </div>
      </td>
      <td className="px-1 py-1">
        <input className={cell} value={vals.unit} onChange={(e) => setVals({ ...vals, unit: e.target.value })} onBlur={() => commit("unit", it.unit)} />
      </td>
      <td className="px-1 py-1">
        <input className={`${cell} text-right font-mono`} inputMode="decimal" value={vals.rate} onChange={(e) => setVals({ ...vals, rate: e.target.value })} onBlur={() => commit("rate", it.rate)} />
      </td>
      {SPLITS.map((s) => (
        <td key={s.key} className="px-0.5 py-1">
          <input
            className={`${cell} text-right font-mono`}
            inputMode="decimal"
            value={vals[s.key]}
            onChange={(e) => setVals({ ...vals, [s.key]: e.target.value })}
            onBlur={() => commit(s.key, it[s.key])}
          />
        </td>
      ))}
      <td className="px-2 py-1 text-xs">
        {!anySplit ? (
          <span className="text-amber-800">No split yet</span>
        ) : Math.abs(diff) < 0.01 ? (
          <span className="text-spruce">✓ adds up{it.cost_estimated ? " (estimate)" : ""}</span>
        ) : (
          <span className="text-brick">{diff > 0 ? `$${diff} unallocated` : `$${Math.abs(diff)} over`}</span>
        )}
      </td>
      <td className="px-1 py-1">
        <button onClick={() => onDelete(it)} className="text-ink-soft hover:text-brick text-lg leading-none" title="Delete this item">
          ×
        </button>
      </td>
    </tr>
  );
}

function AddForm({
  sections,
  categories,
  onDone,
  onError,
}: {
  sections: string[];
  categories: string[];
  onDone: (text: string) => void;
  onError: (text: string) => void;
}) {
  const [f, setF] = useState({ calc: "LM" as "LM" | "QTY" | "MISC", section: sections[0] || "", category: "", name: "", unit: "", rate: "" });
  const [splits, setSplits] = useState<Record<SplitKey, string>>({
    cost_material: "",
    cost_hardware: "",
    cost_factory: "",
    cost_drafting: "",
    cost_studio: "",
    cost_install: "",
  });
  const [busy, setBusy] = useState(false);
  const sum = SPLITS.reduce((a, s) => a + (Number(splits[s.key]) || 0), 0);
  const rate = Number(f.rate) || 0;

  async function submit() {
    setBusy(true);
    const r = await addPriceBookItem({
      calc: f.calc,
      section: f.section,
      category: f.category,
      name: f.name,
      unit: f.unit,
      rate: Number(f.rate),
      splits: Object.fromEntries(SPLITS.map((s) => [s.key, splits[s.key] === "" ? null : Number(splits[s.key])])),
    });
    setBusy(false);
    if ("error" in r) onError(r.error);
    else onDone(`Added "${f.name}"`);
  }

  const inp = "border border-line-strong rounded-md px-2.5 py-2 text-base bg-white w-full";
  return (
    <div className="mb-5 rounded-lg border-2 border-brass bg-paper-raised p-5">
      <h3 className="font-display text-lg font-semibold mb-3">Add a new item</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <label className="md:col-span-2 block text-xs text-ink-soft">
          Item name
          <input className={inp} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Base Cabinet - 18mm Melamine" />
        </label>
        <label className="block text-xs text-ink-soft">
          Priced
          <select className={inp} value={f.calc} onChange={(e) => setF({ ...f, calc: e.target.value as "LM" | "QTY" | "MISC" })}>
            <option value="LM">Per lineal metre</option>
            <option value="QTY">Each (quantity)</option>
            <option value="MISC">Miscellaneous</option>
          </select>
        </label>
        <label className="block text-xs text-ink-soft">
          Unit
          <input className={inp} value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} placeholder={f.calc === "LM" ? "m" : "ea"} />
        </label>
        <label className="block text-xs text-ink-soft">
          Section
          <input className={inp} list="pb-sections" value={f.section} onChange={(e) => setF({ ...f, section: e.target.value })} />
          <datalist id="pb-sections">
            {sections.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
        <label className="block text-xs text-ink-soft">
          Category
          <input className={inp} list="pb-cats" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />
          <datalist id="pb-cats">
            {categories.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
        <label className="block text-xs text-ink-soft">
          Rate (your cost)
          <input className={`${inp} font-mono text-right`} inputMode="decimal" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} placeholder="0.00" />
        </label>
      </div>
      <div className="mt-4">
        <div className="text-xs text-ink-soft mb-1">Where the cost goes (optional, should add up to the rate)</div>
        <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
          {SPLITS.map((s) => (
            <label key={s.key} className="block text-xs text-ink-soft">
              {s.label}
              <input
                className={`${inp} font-mono text-right`}
                inputMode="decimal"
                value={splits[s.key]}
                onChange={(e) => setSplits({ ...splits, [s.key]: e.target.value })}
              />
            </label>
          ))}
        </div>
        {sum > 0 && (
          <div className={`text-xs mt-1 ${Math.abs(sum - rate) < 0.01 ? "text-spruce" : "text-brick"}`}>
            Split total ${sum.toFixed(2)} {Math.abs(sum - rate) < 0.01 ? "— matches the rate ✓" : `— rate is $${rate.toFixed(2)}`}
          </div>
        )}
      </div>
      <div className="mt-4 flex gap-3">
        <button disabled={busy} onClick={submit} className="bg-brass hover:bg-brass-deep text-white rounded-md px-5 py-2 text-base font-semibold disabled:opacity-50">
          {busy ? "Adding…" : "Add to price book"}
        </button>
      </div>
    </div>
  );
}

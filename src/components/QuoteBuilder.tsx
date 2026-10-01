"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveQuote, deleteQuoteAndRedirect, type QuoteItemInput, type QuoteMetaInput } from "@/app/dashboard/quotes/actions";
import { createClient as createBrowserClient } from "@/lib/supabase/client";
import { downloadQuotePdf } from "@/lib/exportPdf";
import { downloadQuoteDocx } from "@/lib/exportDocx";

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

  function bestMaterialMatch(options: PriceBookItem[], hint: string): PriceBookItem | null {
    if (!hint.trim()) return null;
    const h = hint.toLowerCase();
    return options.find((o) => o.name.toLowerCase().includes(h)) || null;
  }

  function findDrawerHardware(brand: string): PriceBookItem | null {
    const b = (brand.trim() || "Merivo").toLowerCase();
    const candidates = priceBook.filter(
      (p) => p.category.toLowerCase() === "hardware" && /^drawer -/i.test(p.name) && p.name.toLowerCase().includes(b)
    );
    return candidates.find((c) => !/push to open/i.test(c.name)) || candidates[0] || null;
  }

  function storagePathFor(userId: string, file: File) {
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    return `${userId}/${Date.now()}-${safeName}`;
  }

  async function handlePlanUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setPlanUploading(true);
    setPlanError(null);
    setPlanResult(null);
    setPlanItemMaterial({});

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
      const planPath = storagePathFor(user.id, file);
      const { error: planUploadError } = await supabase.storage
        .from("plan-uploads")
        .upload(planPath, file, { contentType: file.type });
      if (planUploadError) {
        setPlanError("Could not upload the plan. Please try again.");
        return;
      }

      let schedulePath: string | null = null;
      const scheduleFile = scheduleFileRef.current;
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
      (data.items as PlanItemResult[]).forEach((it, i) => {
        const options = materialOptionsFor(it);
        const match = bestMaterialMatch(options, it.material_hint);
        if (match) defaults[i] = match.id;
      });
      setPlanItemMaterial(defaults);
    } catch {
      setPlanError("Upload failed. Check your connection and try again.");
    } finally {
      setPlanUploading(false);
    }
  }

  function handleScheduleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] || null;
    scheduleFileRef.current = file;
    setScheduleFileName(file?.name || null);
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
      const needsMaterial = categoryPrefixFor(it.cabinet_type) !== null;

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
        note: [it.note, chosen ? chosen.name : ""].filter(Boolean).join(" — "),
        pdf_label: "",
        poa: false,
        flag_label: needsMaterial && !chosen ? "Select material" : it.confidence === "low" ? "Check on site" : "",
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

  const grouped = useMemo(() => {
    const map = new Map<string, LineItem[]>();
    lineItems.forEach((it) => {
      const area = it.area || "General";
      if (!map.has(area)) map.set(area, []);
      map.get(area)!.push(it);
    });
    return map;
  }, [lineItems]);

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
        name: it.name,
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
                            {it.confidence === "low" && (
                              <span className="text-xs text-brick whitespace-nowrap">low confidence</span>
                            )}
                          </div>
                          {it.note && <span className="block text-xs text-ink-soft">{it.note}</span>}
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
                              onChange={(e) =>
                                setPlanItemMaterial((prev) => ({ ...prev, [i]: e.target.value }))
                              }
                            >
                              <option value="">
                                {it.material_hint ? `Select material (plan says "${it.material_hint}")…` : "Select material…"}
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
                  <button onClick={() => setPlanResult(null)} className="text-sm text-ink-soft underline">
                    Discard
                  </button>
                </div>
                <p className="text-xs text-ink-soft mt-2">
                  Items added without a material picked above come in at $0, flagged &quot;Select material&quot; — set them from the price book search above.
                </p>
              </>
            )}
          </div>
        )}
      </section>

      {/* Ledger, grouped by area */}
      <section className="bg-paper-raised border border-line-strong rounded-lg p-5 mb-5">
        <h3 className="font-display text-sm font-semibold mb-3 text-ink-soft uppercase tracking-wide">
          Line items
        </h3>
        {lineItems.length === 0 ? (
          <p className="text-sm text-ink-soft">No items yet — search the price book above to add some.</p>
        ) : (
          areas
            .filter((area) => (grouped.get(area) || []).length > 0)
            .map((area) => (
              <div key={area} className="mb-5 last:mb-0">
                <h4 className="text-xs font-semibold text-brass-deep uppercase tracking-wide mb-2">{area}</h4>
                <div className="space-y-2">
                  {(grouped.get(area) || []).map((it) => (
                    <LineItemRow key={it.key} item={it} onChange={(patch) => updateItem(it.key, patch)} onRemove={() => removeItem(it.key)} />
                  ))}
                </div>
              </div>
            ))
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
  item,
  onChange,
  onRemove,
}: {
  item: LineItem;
  onChange: (patch: Partial<LineItem>) => void;
  onRemove: () => void;
}) {
  const lineTotal = item.poa ? null : item.qty * item.rate;
  return (
    <div className="border border-line rounded-md p-2.5 flex flex-wrap items-center gap-2 bg-paper">
      {item.flag_label && (
        <span className="w-full text-xs font-medium text-brick bg-paper-raised border border-brick rounded px-2 py-1">
          ⚠ {item.flag_label}
        </span>
      )}
      <input
        className="input flex-1 min-w-[180px]"
        value={item.name}
        onChange={(e) => onChange({ name: e.target.value })}
      />
      <input
        type="number"
        step="0.01"
        className="input w-20"
        value={item.qty}
        onChange={(e) => onChange({ qty: Number(e.target.value) })}
        title="Quantity"
      />
      <span className="text-xs text-ink-soft w-10">{item.unit}</span>
      <input
        type="number"
        step="0.01"
        className="input w-24"
        value={item.rate}
        onChange={(e) => onChange({ rate: Number(e.target.value) })}
        title="Rate"
      />
      <label className="flex items-center gap-1 text-xs text-ink-soft whitespace-nowrap">
        <input type="checkbox" checked={item.poa} onChange={(e) => onChange({ poa: e.target.checked })} />
        POA
      </label>
      <span className="font-mono text-sm w-24 text-right">{item.poa ? "POA" : `$${money(lineTotal!)}`}</span>
      <input
        className="input w-28 text-xs"
        placeholder="Room"
        value={item.area}
        onChange={(e) => onChange({ area: e.target.value || "General" })}
      />
      <button onClick={onRemove} className="text-brick text-xs px-2" title="Remove item">
        ✕
      </button>
      <input
        className="input w-full text-xs"
        placeholder="Note (shown on quote)"
        value={item.note}
        onChange={(e) => onChange({ note: e.target.value })}
      />
    </div>
  );
}

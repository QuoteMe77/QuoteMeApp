import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import CostBreakdown from "@/components/CostBreakdown";
import { computeCostBreakdown, mergeCostViews, type CostItem } from "@/lib/costBreakdown";
import { loadPriceBook } from "@/lib/loadPriceBook";
import { ExportItem, NewRevisionButton, NewVariationButton, StatusSelect } from "./ProjectControls";

type Q = {
  id: string;
  kind?: string | null;
  rev?: number | null;
  variation_no?: number | null;
  status?: string | null;
  approved_at?: string | null;
  total?: number | string | null;
  markup_pct?: number | string | null;
  quote_name?: string | null;
  quote_ref?: string | null;
  client_name?: string | null;
  job_address?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};
type Ex = { id: string; quote_id: string; format: string; filename: string; storage_path: string; total: number; created_at: string };

const money = (n: number) => n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dt = (s?: string | null) => (s ? new Date(s).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "");
const revLetter = (n: number) => String.fromCharCode(64 + Math.min(Math.max(n, 1), 26));

export default async function ProjectPage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data } = await supabase.from("quotes").select("*").eq("project_id", params.id);
  const quotes = (data || []) as Q[];
  if (quotes.length === 0) notFound();

  const mains = quotes.filter((q) => (q.kind || "quote") === "quote").sort((a, b) => (b.rev || 1) - (a.rev || 1));
  const vars = quotes.filter((q) => q.kind === "variation").sort((a, b) => (a.variation_no || 0) - (b.variation_no || 0));
  const cur = mains[0] || quotes[0];

  // Every PDF / Word export kept against these quotes, with a short-lived download link.
  const { data: exData } = await supabase
    .from("quote_exports")
    .select("*")
    .in("quote_id", quotes.map((q) => q.id))
    .order("created_at", { ascending: false })
    .limit(80);
  const exportRows = (exData || []) as Ex[];
  const links = new Map<string, string>();
  const viewLinks = new Map<string, string>();
  await Promise.all(
    exportRows.map(async (e) => {
      const { data: s } = await supabase.storage.from("quote-exports").createSignedUrl(e.storage_path, 3600, { download: e.filename });
      if (s?.signedUrl) links.set(e.id, s.signedUrl);
      if (e.format === "pdf") {
        const { data: v } = await supabase.storage.from("quote-exports").createSignedUrl(e.storage_path, 3600);
        if (v?.signedUrl) viewLinks.set(e.id, v.signedUrl);
      }
    })
  );

  // Plans kept for this project (needs plans.sql; shows nothing until it has been run).
  const { data: planData } = await supabase
    .from("project_plans")
    .select("id, quote_id, filename, storage_path, size_bytes, created_at")
    .eq("project_id", params.id)
    .order("created_at", { ascending: false });
  type Pl = { id: string; quote_id: string | null; filename: string; storage_path: string; size_bytes: number | null; created_at: string };
  const plans = (planData || []) as Pl[];
  const planLinks = new Map<string, string>();
  const planViewLinks = new Map<string, string>();
  await Promise.all(
    plans.map(async (pl) => {
      const { data: s } = await supabase.storage.from("project-plans").createSignedUrl(pl.storage_path, 3600, { download: pl.filename });
      if (s?.signedUrl) planLinks.set(pl.id, s.signedUrl);
      // No "download" option, so the browser opens the PDF in a tab to look at.
      const { data: v } = await supabase.storage.from("project-plans").createSignedUrl(pl.storage_path, 3600);
      if (v?.signedUrl) planViewLinks.set(pl.id, v.signedUrl);
    })
  );
  const labelFor = (qid: string | null) => {
    const q = quotes.find((x) => x.id === qid);
    if (!q) return "";
    return q.kind === "variation" ? `Variation ${q.variation_no}` : (q.rev || 1) > 1 ? `Quote Rev ${revLetter(q.rev || 1)}` : "Quote";
  };

  const approvedVars = vars.filter((v) => v.status === "approved");
  const pendingVars = vars.filter((v) => v.status !== "approved" && v.status !== "declined");
  const approvedTotal = approvedVars.reduce((s, v) => s + Number(v.total || 0), 0);
  const pendingTotal = pendingVars.reduce((s, v) => s + Number(v.total || 0), 0);
  const contract = Number(cur.total || 0) + approvedTotal;
  // Cost by department for the whole job: the current quote plus approved variations.
  const contractDocs = [cur, ...approvedVars];
  const { data: itemRows } = await supabase.from("quote_items").select("*").in("quote_id", contractDocs.map((d) => d.id));
  const priceBook = await loadPriceBook(supabase);
  const itemsFor = (qid: string): CostItem[] =>
    ((itemRows || []) as any[])
      .filter((r) => r.quote_id === qid)
      .map((r) => ({
        price_book_item_id: r.price_book_item_id,
        name: r.pdf_label || r.name,
        area: r.area || "General",
        qty: Number(r.qty),
        rate: Number(r.rate),
        poa: !!r.poa,
      }));
  let jobCost = 0;
  let jobMarkup = 0;
  const jobViews = contractDocs.map((d) => {
    const items = itemsFor(d.id);
    const markup = Number(d.markup_pct) || 0;
    const cost = items.reduce((sum, it) => (it.poa ? sum : sum + it.qty * it.rate), 0);
    jobCost += cost;
    jobMarkup += cost * (markup / 100);
    const prefix = d.kind === "variation" ? `Variation ${d.variation_no} — ` : "";
    return computeCostBreakdown(items, priceBook, markup, prefix);
  });
  const jobView = mergeCostViews(jobViews);
  const title = cur.quote_name || `${cur.quote_ref || "(no ref)"} — ${cur.client_name || "No client"}`;

  const renderExports = (qid: string) => {
    const mine = exportRows.filter((e) => e.quote_id === qid);
    if (mine.length === 0) return <div className="text-[11px] text-ink-soft mt-1">No PDF / Word exported yet.</div>;
    return (
      <div className="mt-2 space-y-2">
        {mine.map((e) => (
          <ExportItem
            key={e.id}
            format={e.format}
            date={dt(e.created_at)}
            total={money(Number(e.total))}
            viewUrl={viewLinks.get(e.id)}
            downloadUrl={links.get(e.id)}
          />
        ))}
      </div>
    );
  };

  return (
    <div className="max-w-4xl mx-auto pb-16">
      <div className="mb-1">
        <Link href="/dashboard" className="text-xs text-ink-soft underline">
          ← All projects
        </Link>
      </div>
      <h2 className="font-display text-xl font-semibold">📁 {title}</h2>
      <p className="text-xs text-ink-soft mt-0.5 mb-4">
        {cur.client_name || "No client"} · {cur.job_address || "No site address"}
      </p>

      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="bg-paper-raised border border-line-strong rounded-lg p-3">
          <div className="text-[11px] uppercase tracking-wide text-ink-soft">Current quote</div>
          <div className="font-mono text-base">${money(Number(cur.total || 0))}</div>
        </div>
        <div className="bg-paper-raised border border-line-strong rounded-lg p-3">
          <div className="text-[11px] uppercase tracking-wide text-ink-soft">Approved variations</div>
          <div className="font-mono text-base">${money(approvedTotal)}</div>
          {pendingVars.length > 0 && <div className="text-[11px] text-ink-soft">+ ${money(pendingTotal)} awaiting approval</div>}
        </div>
        <div className="bg-paper-raised border border-line-strong rounded-lg p-3">
          <div className="text-[11px] uppercase tracking-wide text-ink-soft">Contract value (ex GST)</div>
          <div className="font-mono text-base font-semibold">${money(contract)}</div>
        </div>
      </div>

      {jobCost > 0 && (
        <div className="mb-6">
          <CostBreakdown view={jobView} subtotal={jobCost} markupAmount={jobMarkup} total={jobCost + jobMarkup} title="Job cost breakdown" open />
          <p className="text-xs text-ink-soft mt-1">Covers the current quote and approved variations (ex GST).</p>
        </div>
      )}

      <section className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold text-sm">Quote &amp; revisions</h3>
          <NewRevisionButton quoteId={cur.id} locked={cur.status === "accepted"} />
        </div>
        <div className="bg-paper-raised border border-line-strong rounded-lg divide-y divide-line">
          {mains.map((q, i) => (
            <div key={q.id} className="px-5 py-3">
              <div className="flex items-center justify-between gap-3">
                <Link href={`/dashboard/quotes/${q.id}`} className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {mains.length > 1 ? `Rev ${revLetter(q.rev || 1)}` : "Quote"}
                    {i === 0 && mains.length > 1 && <span className="ml-2 text-[11px] text-spruce">current</span>}
                    <span className="ml-2 text-xs font-normal text-ink-soft">{q.quote_ref ? `Ref ${q.quote_ref}` : ""} · {dt(q.updated_at || q.created_at)}</span>
                  </div>
                </Link>
                <div className="font-mono text-sm">${money(Number(q.total || 0))}</div>
                <StatusSelect id={q.id} kind="quote" status={q.status || "draft"} />
                <Link href={`/dashboard/quotes/${q.id}`} className="text-xs underline text-brass-deep">
                  Open
                </Link>
              </div>
              {renderExports(q.id)}
            </div>
          ))}
        </div>
      </section>

      <section className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold text-sm">Variations</h3>
          <NewVariationButton projectId={params.id} />
        </div>
        {vars.length === 0 ? (
          <div className="bg-paper-raised border border-line-strong rounded-lg p-5 text-sm text-ink-soft">
            No variations yet. Use “New variation” when the client adds to or changes the job after accepting the quote. Variations are payable with the next progress claim.
          </div>
        ) : (
          <div className="bg-paper-raised border border-line-strong rounded-lg divide-y divide-line">
            {vars.map((v) => (
              <div key={v.id} className="px-5 py-3">
                <div className="flex items-center justify-between gap-3">
                  <Link href={`/dashboard/quotes/${v.id}`} className="min-w-0 flex-1">
                    <div className="text-sm font-medium">
                      Variation {v.variation_no}
                      <span className="ml-2 text-xs font-normal text-ink-soft">
                        {v.quote_ref ? `Ref ${v.quote_ref}` : ""} · {dt(v.updated_at || v.created_at)}
                        {v.status === "approved" && v.approved_at ? ` · approved ${dt(v.approved_at)}` : ""}
                      </span>
                    </div>
                  </Link>
                  <div className="font-mono text-sm">${money(Number(v.total || 0))}</div>
                  <StatusSelect id={v.id} kind="variation" status={v.status || "draft"} />
                  <Link href={`/dashboard/quotes/${v.id}`} className="text-xs underline text-brass-deep">
                    Open
                  </Link>
                </div>
                {renderExports(v.id)}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3 className="font-semibold text-sm mb-2">Drawings</h3>
        {plans.length === 0 ? (
          <div className="bg-paper-raised border border-line-strong rounded-lg p-5 text-sm text-ink-soft">
            No drawings kept yet. When you read a plan and save the quote, the plan is stored here, and each quote line can show where it was read from.
          </div>
        ) : (
          <div className="bg-paper-raised border border-line-strong rounded-lg divide-y divide-line">
            {plans.map((pl) => (
              <div key={pl.id} className="px-5 py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">📐 {pl.filename}</div>
                  <div className="text-xs text-ink-soft">
                    {dt(pl.created_at)}
                    {labelFor(pl.quote_id) ? ` · read for ${labelFor(pl.quote_id)}` : ""}
                    {pl.size_bytes ? ` · ${(Number(pl.size_bytes) / (1024 * 1024)).toFixed(1)} MB` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  {planViewLinks.get(pl.id) && (
                    <a href={planViewLinks.get(pl.id)} target="_blank" rel="noopener noreferrer" className="text-sm font-medium underline text-brass-deep">
                      View
                    </a>
                  )}
                  {planLinks.get(pl.id) && (
                    <a href={planLinks.get(pl.id)} className="text-xs underline text-ink-soft">
                      Download
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

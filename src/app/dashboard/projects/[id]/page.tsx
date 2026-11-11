import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { NewRevisionButton, NewVariationButton, StatusSelect } from "./ProjectControls";

type Q = {
  id: string;
  kind?: string | null;
  rev?: number | null;
  variation_no?: number | null;
  status?: string | null;
  approved_at?: string | null;
  total?: number | string | null;
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
  await Promise.all(
    exportRows.map(async (e) => {
      const { data: s } = await supabase.storage.from("quote-exports").createSignedUrl(e.storage_path, 3600, { download: e.filename });
      if (s?.signedUrl) links.set(e.id, s.signedUrl);
    })
  );

  const approvedVars = vars.filter((v) => v.status === "approved");
  const pendingVars = vars.filter((v) => v.status !== "approved" && v.status !== "declined");
  const approvedTotal = approvedVars.reduce((s, v) => s + Number(v.total || 0), 0);
  const pendingTotal = pendingVars.reduce((s, v) => s + Number(v.total || 0), 0);
  const contract = Number(cur.total || 0) + approvedTotal;
  const title = cur.quote_name || `${cur.quote_ref || "(no ref)"} — ${cur.client_name || "No client"}`;

  const renderExports = (qid: string) => {
    const mine = exportRows.filter((e) => e.quote_id === qid);
    if (mine.length === 0) return <div className="text-[11px] text-ink-soft mt-1">No PDF / Word exported yet.</div>;
    return (
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
        {mine.map((e) => (
          <span key={e.id} className="text-[11px] text-ink-soft">
            {links.get(e.id) ? (
              <a href={links.get(e.id)} className="text-brass-deep underline">
                {e.format === "pdf" ? "PDF" : "Word"}
              </a>
            ) : (
              <span>{e.format === "pdf" ? "PDF" : "Word"}</span>
            )}{" "}
            {dt(e.created_at)} · ${money(Number(e.total))}
          </span>
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
        <div className="bg-paper-raised border border-line-strong rounded-lg p-5 text-sm text-ink-soft">
          Drawing storage for this project is coming next — the plans each quote or variation was priced from will be kept here.
        </div>
      </section>
    </div>
  );
}

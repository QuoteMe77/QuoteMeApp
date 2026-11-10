import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import QuoteListRow from "./QuoteListRow";
import ProjectListRow, { type ProjectSummary } from "./ProjectListRow";

type Q = {
  id: string;
  project_id?: string | null;
  kind?: string | null;
  rev?: number | null;
  status?: string | null;
  total?: number | string | null;
  quote_name?: string | null;
  quote_ref?: string | null;
  client_name?: string | null;
  job_address?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
};

const STATUS_LABEL: Record<string, string> = { draft: "Draft", sent: "Sent", accepted: "Accepted", approved: "Approved", declined: "Declined" };

export default async function QuotesListPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data } = await supabase.from("quotes").select("*").order("created_at", { ascending: false }).limit(300);
  const quotes = (data || []) as Q[];
  // Project folders exist once projects.sql has been run; until then show the plain quote list.
  const hasProjects = quotes.length === 0 || quotes.some((q) => "project_id" in q);

  const groups = new Map<string, Q[]>();
  const loose: Q[] = [];
  for (const q of quotes) {
    if (hasProjects && q.project_id) groups.set(q.project_id, [...(groups.get(q.project_id) || []), q]);
    else loose.push(q);
  }

  const projects: ProjectSummary[] = Array.from(groups.entries()).map(([id, qs]) => {
    const mains = qs.filter((q) => (q.kind || "quote") === "quote").sort((a, b) => (b.rev || 1) - (a.rev || 1));
    const vars = qs.filter((q) => q.kind === "variation");
    const cur = mains[0] || qs[0];
    const approved = vars.filter((v) => v.status === "approved").reduce((s, v) => s + Number(v.total || 0), 0);
    const title = cur.quote_name || `${cur.quote_ref || "(no ref)"} — ${cur.client_name || "No client"}`;
    const last = qs.map((q) => q.updated_at || q.created_at || "").sort().pop() || "";
    return {
      id,
      title,
      sub: `${cur.quote_name ? `${cur.client_name || "No client"} · ` : ""}${cur.job_address || "—"}`,
      value: Number(cur.total || 0) + approved,
      variations: vars.length,
      status: STATUS_LABEL[cur.status || "draft"] || "Draft",
      updated: last ? new Date(last).toLocaleDateString() : "",
    };
  });
  projects.sort((a, b) => (a.updated < b.updated ? 1 : -1));

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-5">
        <h2 className="font-display text-xl font-semibold">{hasProjects ? "My projects" : "My quotes"}</h2>
        <Link
          href="/dashboard/quotes/new"
          className="bg-brass hover:bg-brass-deep text-white rounded-md px-4 py-2 text-sm font-medium"
        >
          + New quote
        </Link>
      </div>

      {projects.length === 0 && loose.length === 0 ? (
        <div className="bg-paper-raised border border-line-strong rounded-lg p-10 text-center">
          <p className="text-ink-soft text-sm mb-4">No quotes yet.</p>
          <Link href="/dashboard/quotes/new" className="text-brass-deep underline text-sm">
            Create your first quote
          </Link>
        </div>
      ) : (
        <div className="bg-paper-raised border border-line-strong rounded-lg divide-y divide-line">
          {projects.map((p) => (
            <ProjectListRow key={p.id} p={p} />
          ))}
          {loose.map((q) => (
            <QuoteListRow key={q.id} q={q} />
          ))}
        </div>
      )}
    </div>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function QuotesListPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: quotes } = await supabase
    .from("quotes")
    .select("id, quote_ref, client_name, job_address, total, updated_at, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-5">
        <h2 className="font-display text-xl font-semibold">Quotes</h2>
        <Link
          href="/dashboard/quotes/new"
          className="bg-brass hover:bg-brass-deep text-white rounded-md px-4 py-2 text-sm font-medium"
        >
          + New quote
        </Link>
      </div>

      {!quotes || quotes.length === 0 ? (
        <div className="bg-paper-raised border border-line-strong rounded-lg p-10 text-center">
          <p className="text-ink-soft text-sm mb-4">No quotes yet.</p>
          <Link href="/dashboard/quotes/new" className="text-brass-deep underline text-sm">
            Create your first quote
          </Link>
        </div>
      ) : (
        <div className="bg-paper-raised border border-line-strong rounded-lg divide-y divide-line">
          {quotes.map((q) => (
            <Link
              key={q.id}
              href={`/dashboard/quotes/${q.id}`}
              className="flex items-center justify-between px-5 py-3.5 hover:bg-paper transition-colors"
            >
              <div>
                <div className="font-medium text-sm">
                  {q.quote_ref || "(no ref)"} — {q.client_name || "No client"}
                </div>
                <div className="text-xs text-ink-soft mt-0.5">{q.job_address || "—"}</div>
              </div>
              <div className="text-right">
                <div className="font-mono text-sm">
                  ${Number(q.total || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </div>
                <div className="text-xs text-ink-soft mt-0.5">
                  {new Date(q.updated_at || q.created_at).toLocaleDateString()}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

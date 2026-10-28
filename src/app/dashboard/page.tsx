import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import QuoteListRow from "./QuoteListRow";

export default async function QuotesListPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: quotes } = await supabase
    .from("quotes")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-5">
        <h2 className="font-display text-xl font-semibold">My quotes</h2>
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
            <QuoteListRow key={q.id} q={q} />
          ))}
        </div>
      )}
    </div>
  );
}

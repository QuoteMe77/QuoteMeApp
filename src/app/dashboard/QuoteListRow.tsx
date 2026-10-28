"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteQuote } from "./quotes/actions";

export type QuoteRow = {
  id: string;
  quote_name?: string | null;
  quote_ref?: string | null;
  client_name?: string | null;
  job_address?: string | null;
  total?: number | string | null;
  updated_at?: string | null;
  created_at?: string | null;
};

export default function QuoteListRow({ q }: { q: QuoteRow }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const title = q.quote_name || `${q.quote_ref || "(no ref)"} — ${q.client_name || "No client"}`;

  function handleDelete() {
    if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return;
    setError("");
    startTransition(async () => {
      const res = await deleteQuote(q.id);
      if ("error" in res) setError(res.error);
      else router.refresh();
    });
  }

  return (
    <div className={`flex items-center hover:bg-paper transition-colors ${isPending ? "opacity-50" : ""}`}>
      <Link href={`/dashboard/quotes/${q.id}`} className="flex flex-1 items-center justify-between px-5 py-3.5 min-w-0">
        <div className="min-w-0">
          <div className="font-medium text-sm truncate">{title}</div>
          <div className="text-xs text-ink-soft mt-0.5">
            {q.quote_name ? `${q.client_name || "No client"} · ` : ""}
            {q.job_address || "—"}
            {q.quote_ref ? ` · Ref ${q.quote_ref}` : ""}
          </div>
          {error && <div className="text-xs text-brick mt-0.5">{error}</div>}
        </div>
        <div className="text-right pl-4 shrink-0">
          <div className="font-mono text-sm">${Number(q.total || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
          <div className="text-xs text-ink-soft mt-0.5">
            {new Date((q.updated_at || q.created_at) as string).toLocaleDateString()}
          </div>
        </div>
      </Link>
      <button
        onClick={handleDelete}
        disabled={isPending}
        className="mr-4 shrink-0 text-xs text-brick underline underline-offset-2 hover:text-red-800 disabled:opacity-50"
        title="Delete this quote"
      >
        Delete
      </button>
    </div>
  );
}

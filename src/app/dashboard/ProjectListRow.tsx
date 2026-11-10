"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteProject } from "./quotes/actions";

export type ProjectSummary = {
  id: string;
  title: string;
  sub: string;
  value: number;
  variations: number;
  status: string;
  updated: string;
};

export default function ProjectListRow({ p }: { p: ProjectSummary }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState("");

  function handleDelete() {
    if (!window.confirm(`Delete the whole project "${p.title}", including every revision and variation? This cannot be undone.`)) return;
    setError("");
    startTransition(async () => {
      const res = await deleteProject(p.id);
      if ("error" in res) setError(res.error);
      else router.refresh();
    });
  }

  return (
    <div className={`flex items-center hover:bg-paper transition-colors ${isPending ? "opacity-50" : ""}`}>
      <Link href={`/dashboard/projects/${p.id}`} className="flex flex-1 items-center justify-between px-5 py-3.5 min-w-0">
        <div className="min-w-0">
          <div className="font-medium text-sm truncate">📁 {p.title}</div>
          <div className="text-xs text-ink-soft mt-0.5 truncate">
            {p.sub}
            {p.variations > 0 ? ` · ${p.variations} variation${p.variations === 1 ? "" : "s"}` : ""} · {p.status}
          </div>
          {error && <div className="text-xs text-brick mt-0.5">{error}</div>}
        </div>
        <div className="text-right pl-4 shrink-0">
          <div className="font-mono text-sm">${p.value.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
          <div className="text-xs text-ink-soft mt-0.5">{p.updated}</div>
        </div>
      </Link>
      <button
        onClick={handleDelete}
        disabled={isPending}
        className="mr-4 shrink-0 text-xs text-brick underline underline-offset-2 hover:text-red-800 disabled:opacity-50"
        title="Delete this project"
      >
        Delete
      </button>
    </div>
  );
}

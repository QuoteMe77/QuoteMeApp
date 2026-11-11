"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createRevision, createVariation, setQuoteStatus } from "../../quotes/actions";

export function StatusSelect({ id, kind, status }: { id: string; kind: "quote" | "variation"; status: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const doneValue = kind === "variation" ? "approved" : "accepted";
  const doneLabel = kind === "variation" ? "Approved" : "Accepted";
  const locked = status === "accepted" || status === "approved";

  function change(next: string) {
    setError("");
    startTransition(async () => {
      const res = await setQuoteStatus(id, next);
      if ("error" in res) setError(res.error);
      else router.refresh();
    });
  }

  return (
    <span className="inline-flex items-center gap-2">
      <select
        className="input !py-1 !text-xs w-28"
        value={status}
        disabled={isPending}
        onChange={(e) => change(e.target.value)}
        title="Status"
      >
        <option value="draft">Draft</option>
        <option value="sent">Sent</option>
        <option value={doneValue}>{doneLabel} ✓</option>
        <option value="declined">Declined</option>
      </select>
      {locked && <span className="text-[11px] text-spruce">🔒 locked</span>}
      {error && <span className="text-[11px] text-brick">{error}</span>}
    </span>
  );
}

export function NewRevisionButton({ quoteId, locked }: { quoteId: string; locked: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState("");
  function go() {
    if (locked && !window.confirm("This quote is accepted. A revision is for changes BEFORE acceptance — for changes after acceptance, create a variation instead. Create a revision anyway?")) return;
    setError("");
    startTransition(async () => {
      const res = await createRevision(quoteId);
      if ("error" in res) setError(res.error);
      else router.push(`/dashboard/quotes/${res.id}`);
    });
  }
  return (
    <span>
      <button onClick={go} disabled={isPending} className="text-xs border border-line-strong rounded-md px-3 py-1.5 hover:bg-paper disabled:opacity-50">
        {isPending ? "Creating…" : "+ New revision"}
      </button>
      {error && <span className="text-xs text-brick ml-2">{error}</span>}
    </span>
  );
}

export function NewVariationButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState("");
  function go() {
    setError("");
    startTransition(async () => {
      const res = await createVariation(projectId);
      if ("error" in res) setError(res.error);
      else router.push(`/dashboard/quotes/${res.id}`);
    });
  }
  return (
    <span>
      <button onClick={go} disabled={isPending} className="bg-brass hover:bg-brass-deep text-white rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50">
        {isPending ? "Creating…" : "+ New variation"}
      </button>
      {error && <span className="text-xs text-brick ml-2">{error}</span>}
    </span>
  );
}

// A saved PDF or Word export: PDFs can be previewed right here; Word files can only be downloaded.
export function ExportItem({
  format,
  date,
  total,
  viewUrl,
  downloadUrl,
}: {
  format: string;
  date: string;
  total: string;
  viewUrl?: string;
  downloadUrl?: string;
}) {
  const [open, setOpen] = useState(false);
  const isPdf = format === "pdf";
  return (
    <div className="w-full">
      <div className="text-[11px] text-ink-soft flex flex-wrap items-center gap-x-3">
        <span className="font-medium text-ink">{isPdf ? "PDF" : "Word"}</span>
        <span>
          {date} · ${total}
        </span>
        {isPdf && viewUrl && (
          <button type="button" onClick={() => setOpen((o) => !o)} className="text-brass-deep underline">
            {open ? "Hide preview" : "Preview"}
          </button>
        )}
        {downloadUrl && (
          <a href={downloadUrl} className="text-brass-deep underline">
            Download
          </a>
        )}
      </div>
      {isPdf && open && viewUrl && (
        <iframe src={viewUrl} title="PDF preview" className="mt-2 w-full rounded border border-line-strong bg-white" style={{ height: 720 }} />
      )}
    </div>
  );
}

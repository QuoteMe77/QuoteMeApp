"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { resetTerms, saveTerms } from "../actions";
import type { QuoteTerms } from "@/lib/quoteTerms";

type Group = { heading?: string; items: string[] };
type Section = { title: string; groups: Group[] };

function move<T>(arr: T[], i: number, d: -1 | 1): T[] {
  const j = i + d;
  if (j < 0 || j >= arr.length) return arr;
  const c = arr.slice();
  [c[i], c[j]] = [c[j], c[i]];
  return c;
}

function AutoArea({ value, onChange, className = "" }: { value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <textarea
      className={`w-full border border-line-strong rounded-md px-2.5 py-2 text-sm bg-white leading-snug resize-y ${className}`}
      rows={Math.min(8, Math.max(2, Math.ceil(value.length / 110)))}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function ItemList({ items, onChange, addLabel }: { items: string[]; onChange: (a: string[]) => void; addLabel: string }) {
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={i} className="flex gap-2 items-start">
          <div className="flex-1">
            <AutoArea value={it} onChange={(v) => onChange(items.map((x, k) => (k === i ? v : x)))} />
          </div>
          <div className="flex flex-col gap-1 pt-0.5">
            <button onClick={() => onChange(move(items, i, -1))} disabled={i === 0} className="text-xs border border-line-strong rounded px-1.5 py-0.5 hover:bg-white disabled:opacity-30" title="Move up">
              ↑
            </button>
            <button onClick={() => onChange(move(items, i, 1))} disabled={i === items.length - 1} className="text-xs border border-line-strong rounded px-1.5 py-0.5 hover:bg-white disabled:opacity-30" title="Move down">
              ↓
            </button>
          </div>
          <button onClick={() => onChange(items.filter((_, k) => k !== i))} className="text-ink-soft hover:text-brick text-xl leading-none pt-1" title="Remove this line">
            ×
          </button>
        </div>
      ))}
      <button onClick={() => onChange([...items, ""])} className="text-sm text-brass-deep font-medium hover:underline">
        + {addLabel}
      </button>
    </div>
  );
}

export default function TermsEditor({ initial, saved }: { initial: QuoteTerms; saved: boolean }) {
  const router = useRouter();
  const [inclusions, setInclusions] = useState<string[]>(initial.inclusions);
  const [sections, setSections] = useState<Section[]>(initial.sections.map((s) => ({ title: s.title, groups: s.groups.map((g) => ({ heading: g.heading, items: [...g.items] })) })));
  const [approval, setApproval] = useState(initial.approvalText);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);

  const touch = <T,>(setter: (v: T) => void) => (v: T) => {
    setDirty(true);
    setter(v);
  };

  async function save() {
    setBusy(true);
    const r = await saveTerms({ inclusions, sections, approvalText: approval });
    setBusy(false);
    if ("error" in r) setMsg({ kind: "err", text: r.error });
    else {
      setMsg({ kind: "ok", text: "Saved. New PDF and Word quotes will use these terms." });
      setDirty(false);
      router.refresh();
    }
  }

  async function reset() {
    if (!window.confirm("Throw away your edits and go back to the standard wording?")) return;
    setBusy(true);
    const r = await resetTerms();
    setBusy(false);
    if ("error" in r) setMsg({ kind: "err", text: r.error });
    else window.location.reload();
  }

  const setSection = (i: number, s: Section) => touch(setSections)(sections.map((x, k) => (k === i ? s : x)));

  return (
    <div className="pb-24">
      <p className="text-sm text-ink-soft mb-2">
        This wording is printed on every PDF and Word quote you send. Edit it, add lines, remove what doesn&apos;t apply, or reorder it.
        {!saved && " You're currently using the standard wording — change anything and save to make it your own."}
      </p>
      <p className="text-xs text-ink-soft mb-5">
        Formatting tips: start a line with <code className="bg-white px-1 rounded border border-line">~ </code> to print it as an italic note, or put{" "}
        <code className="bg-white px-1 rounded border border-line">[[bold words]]</code> at the start of a line to bold a lead-in. Changes only affect quotes exported after you save.
      </p>

      <section className="bg-paper-raised border border-line-strong rounded-lg p-5 mb-5">
        <h3 className="font-display text-lg font-semibold mb-1">What&apos;s included</h3>
        <p className="text-sm text-ink-soft mb-3">The &quot;Inclusions&quot; list printed near the top of the quote.</p>
        <ItemList items={inclusions} onChange={touch(setInclusions)} addLabel="Add an inclusion" />
      </section>

      {sections.map((sec, si) => (
        <section key={si} className="bg-paper-raised border border-line-strong rounded-lg p-5 mb-5">
          <div className="flex items-center gap-3 mb-3">
            <input
              className="flex-1 border border-line-strong rounded-md px-3 py-2 font-display text-lg font-semibold bg-white"
              value={sec.title}
              onChange={(e) => setSection(si, { ...sec, title: e.target.value })}
              placeholder="Section heading, e.g. Joinery Terms"
            />
            <button onClick={() => touch(setSections)(move(sections, si, -1))} disabled={si === 0} className="border border-line-strong rounded px-2 py-1 hover:bg-white disabled:opacity-30" title="Move section up">
              ↑
            </button>
            <button onClick={() => touch(setSections)(move(sections, si, 1))} disabled={si === sections.length - 1} className="border border-line-strong rounded px-2 py-1 hover:bg-white disabled:opacity-30" title="Move section down">
              ↓
            </button>
            <button
              onClick={() => {
                if (window.confirm(`Remove the whole "${sec.title || "untitled"}" section?`)) touch(setSections)(sections.filter((_, k) => k !== si));
              }}
              className="text-sm text-brick hover:underline"
            >
              Remove section
            </button>
          </div>
          {sec.groups.map((g, gi) => (
            <div key={gi} className="mb-4">
              {(g.heading !== undefined || sec.groups.length > 1) && (
                <input
                  className="w-full border border-line-strong rounded-md px-3 py-1.5 text-sm font-semibold bg-white mb-2"
                  value={g.heading || ""}
                  placeholder="Sub-heading (optional)"
                  onChange={(e) => setSection(si, { ...sec, groups: sec.groups.map((x, k) => (k === gi ? { ...x, heading: e.target.value } : x)) })}
                />
              )}
              <ItemList
                items={g.items}
                onChange={(a) => setSection(si, { ...sec, groups: sec.groups.map((x, k) => (k === gi ? { ...x, items: a } : x)) })}
                addLabel="Add a line"
              />
            </div>
          ))}
        </section>
      ))}

      <button onClick={() => touch(setSections)([...sections, { title: "", groups: [{ items: [""] }] }])} className="border border-line-strong rounded-md px-4 py-2 text-base hover:bg-white mb-6">
        + Add a new section
      </button>

      <section className="bg-paper-raised border border-line-strong rounded-lg p-5 mb-5">
        <h3 className="font-display text-lg font-semibold mb-1">Client approval wording</h3>
        <p className="text-sm text-ink-soft mb-3">Printed above the signature lines at the end of the quote.</p>
        <input className="w-full border border-line-strong rounded-md px-3 py-2 text-base bg-white" value={approval} onChange={(e) => touch(setApproval)(e.target.value)} />
      </section>

      <div className="fixed bottom-0 left-0 right-0 z-10 border-t border-line-strong bg-paper-raised px-5 py-3 flex items-center gap-4 shadow-[0_-2px_8px_rgba(0,0,0,0.08)]">
        <div className="max-w-6xl mx-auto w-full flex items-center gap-4">
          <button onClick={save} disabled={busy} className="bg-brass hover:bg-brass-deep text-white rounded-md px-6 py-2.5 text-base font-semibold disabled:opacity-50">
            {busy ? "Saving…" : "Save terms"}
          </button>
          {dirty && !msg && <span className="text-sm text-amber-800">You have unsaved changes</span>}
          {msg && <span className={`text-sm ${msg.kind === "ok" ? "text-spruce" : "text-brick"}`}>{msg.text}</span>}
          {saved && (
            <button onClick={reset} disabled={busy} className="ml-auto text-sm text-ink-soft underline">
              Reset to standard wording
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

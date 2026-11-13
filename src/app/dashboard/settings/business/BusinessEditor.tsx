"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveBusiness } from "../actions";
import type { OrgSettings } from "@/lib/orgSettings";

// Shrinks a chosen logo to at most 600px wide and returns it as a data URL plus its width/height ratio.
function readLogo(file: File): Promise<{ dataUrl: string; ratio: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 600 / img.width);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      if (!ctx) return reject(new Error("no canvas"));
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve({ dataUrl: c.toDataURL("image/png"), ratio: w / h });
    };
    img.onerror = () => reject(new Error("That file couldn't be read as an image."));
    img.src = url;
  });
}

const num = (v: string) => (v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export default function BusinessEditor({ name, contact, settings }: { name: string; contact: string; settings: OrgSettings }) {
  const router = useRouter();
  const [f, setF] = useState({
    name,
    contact,
    abn: settings.abn,
    address: settings.address,
    deposit: settings.deposit_pct === null ? "" : String(settings.deposit_pct),
    markup: settings.default_markup_pct === null ? "" : String(settings.default_markup_pct),
    valid: settings.default_valid_days === null ? "" : String(settings.default_valid_days),
    acctName: settings.bank_account_name,
    bank: settings.bank_name,
    bsb: settings.bank_bsb,
    acctNo: settings.bank_account_no,
  });
  const [logo, setLogo] = useState<{ dataUrl: string; ratio: number } | null>(settings.logo_data && settings.logo_ratio ? { dataUrl: settings.logo_data, ratio: settings.logo_ratio } : null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const checklist = [
    { label: "Business name", done: !!f.name.trim() },
    { label: "Logo", done: !!logo },
    { label: "Contact details", done: !!f.contact.trim() },
    { label: "ABN", done: !!f.abn.trim() },
    { label: "Deposit %", done: f.deposit.trim() !== "" },
    { label: "Bank details", done: !!f.bsb.trim() && !!f.acctNo.trim() },
    { label: "Your terms & conditions", done: null as boolean | null },
    { label: "Your price book", done: null as boolean | null },
  ];

  async function onLogo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setLogo(await readLogo(file));
    } catch (err) {
      setMsg({ kind: "err", text: (err as Error).message });
    }
  }

  async function save(markComplete = false) {
    setBusy(true);
    setMsg(null);
    const r = await saveBusiness({
      name: f.name,
      contact: f.contact,
      abn: f.abn,
      address: f.address,
      logo_data: logo?.dataUrl || null,
      logo_ratio: logo?.ratio || null,
      deposit_pct: num(f.deposit),
      bank_account_name: f.acctName,
      bank_name: f.bank,
      bank_bsb: f.bsb,
      bank_account_no: f.acctNo,
      default_markup_pct: num(f.markup),
      default_valid_days: num(f.valid),
      markSetupComplete: markComplete,
    });
    setBusy(false);
    if ("error" in r) setMsg({ kind: "err", text: r.error });
    else {
      setMsg({ kind: "ok", text: markComplete ? "Saved — setup marked complete." : "Saved. New quotes will use these details." });
      router.refresh();
    }
  }

  const inp = "w-full border border-line-strong rounded-md px-3 py-2 text-base bg-white";
  const label = "block text-sm text-ink-soft";

  return (
    <div className="pb-24">
      <div className="grid lg:grid-cols-[1fr_280px] gap-6">
        <div className="space-y-5">
          <section className="bg-paper-raised border border-line-strong rounded-lg p-5">
            <h3 className="font-display text-lg font-semibold mb-3">Your business</h3>
            <div className="grid md:grid-cols-2 gap-4">
              <label className={label}>
                Business name
                <input className={inp} value={f.name} onChange={set("name")} />
              </label>
              <label className={label}>
                ABN
                <input className={inp} value={f.abn} onChange={set("abn")} placeholder="00 000 000 000" />
              </label>
              <label className={`${label} md:col-span-2`}>
                Contact details (shown on the quote)
                <input className={inp} value={f.contact} onChange={set("contact")} placeholder="Phone · email · website" />
              </label>
              <label className={`${label} md:col-span-2`}>
                Business address
                <input className={inp} value={f.address} onChange={set("address")} />
              </label>
            </div>
            <div className="mt-5">
              <div className={label}>Logo (shown at the top of your PDF and Word quotes)</div>
              <div className="mt-2 flex items-center gap-4">
                <div className="h-16 min-w-[160px] border border-dashed border-line-strong rounded-md bg-white flex items-center justify-center px-3">
                  {logo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logo.dataUrl} alt="Your logo" className="max-h-14 max-w-[220px]" />
                  ) : (
                    <span className="text-sm text-ink-soft">No logo yet — your name is used instead</span>
                  )}
                </div>
                <label className="border border-line-strong rounded-md px-4 py-2 text-base cursor-pointer hover:bg-white">
                  {logo ? "Change logo" : "Upload logo"}
                  <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={onLogo} />
                </label>
                {logo && (
                  <button onClick={() => setLogo(null)} className="text-sm text-ink-soft underline">
                    Remove
                  </button>
                )}
              </div>
              <p className="text-xs text-ink-soft mt-1">A PNG or JPG with a plain or transparent background works best.</p>
            </div>
          </section>

          <section className="bg-paper-raised border border-line-strong rounded-lg p-5">
            <h3 className="font-display text-lg font-semibold mb-1">Quote defaults</h3>
            <p className="text-sm text-ink-soft mb-3">Used when you start a new quote. You can still change them on each quote.</p>
            <div className="grid md:grid-cols-3 gap-4">
              <label className={label}>
                Markup %
                <input className={inp} inputMode="decimal" value={f.markup} onChange={set("markup")} placeholder="32" />
              </label>
              <label className={label}>
                Quote valid for (days)
                <input className={inp} inputMode="numeric" value={f.valid} onChange={set("valid")} placeholder="30" />
              </label>
              <label className={label}>
                Deposit % on acceptance
                <input className={inp} inputMode="decimal" value={f.deposit} onChange={set("deposit")} placeholder="e.g. 10" />
              </label>
            </div>
            <p className="text-xs text-ink-soft mt-2">If you enter a deposit %, the quote shows the deposit amount below the total. It's recalculated whenever the quote total changes.</p>
          </section>

          <section className="bg-paper-raised border border-line-strong rounded-lg p-5">
            <h3 className="font-display text-lg font-semibold mb-1">Payment details</h3>
            <p className="text-sm text-ink-soft mb-3">Printed on the quote so clients know where to pay the deposit. Leave blank to leave them off.</p>
            <div className="grid md:grid-cols-2 gap-4">
              <label className={label}>
                Account name
                <input className={inp} value={f.acctName} onChange={set("acctName")} />
              </label>
              <label className={label}>
                Bank
                <input className={inp} value={f.bank} onChange={set("bank")} />
              </label>
              <label className={label}>
                BSB
                <input className={inp} value={f.bsb} onChange={set("bsb")} placeholder="000-000" />
              </label>
              <label className={label}>
                Account number
                <input className={inp} value={f.acctNo} onChange={set("acctNo")} />
              </label>
            </div>
          </section>
        </div>

        <aside className="lg:sticky lg:top-4 h-fit bg-paper-raised border border-line-strong rounded-lg p-5">
          <h3 className="font-display text-lg font-semibold mb-3">Setup checklist</h3>
          <ul className="space-y-2 text-sm">
            {checklist.map((c) => (
              <li key={c.label} className="flex items-center gap-2">
                <span className={c.done ? "text-spruce" : c.done === null ? "text-ink-soft" : "text-amber-700"}>{c.done ? "✓" : c.done === null ? "→" : "○"}</span>
                <span className={c.done ? "text-ink" : "text-ink-soft"}>{c.label}</span>
                {c.done === null && <span className="text-xs text-ink-soft">(see tab)</span>}
              </li>
            ))}
          </ul>
          {settings.setup_completed_at && <p className="text-xs text-spruce mt-3">Setup completed {new Date(settings.setup_completed_at).toLocaleDateString()}</p>}
        </aside>
      </div>

      <div className="fixed bottom-0 left-0 right-0 z-10 border-t border-line-strong bg-paper-raised px-5 py-3 shadow-[0_-2px_8px_rgba(0,0,0,0.08)]">
        <div className="max-w-6xl mx-auto w-full flex items-center gap-4">
          <button onClick={() => save(false)} disabled={busy} className="bg-brass hover:bg-brass-deep text-white rounded-md px-6 py-2.5 text-base font-semibold disabled:opacity-50">
            {busy ? "Saving…" : "Save"}
          </button>
          <button onClick={() => save(true)} disabled={busy} className="border border-line-strong rounded-md px-4 py-2.5 text-base hover:bg-white disabled:opacity-50">
            Save &amp; mark setup complete
          </button>
          {msg && <span className={`text-sm ${msg.kind === "ok" ? "text-spruce" : "text-brick"}`}>{msg.text}</span>}
        </div>
      </div>
    </div>
  );
}

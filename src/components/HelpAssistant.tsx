"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

type Msg = { role: "user" | "assistant"; content: string };

const SUGGESTIONS = ["How do I read a plan?", "How do I add items without plans?", "How do variations work?", "Where do I change my terms and conditions?"];

export default function HelpAssistant() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [msgs, busy, open]);

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    const next: Msg[] = [...msgs, { role: "user", content: q }];
    setMsgs(next);
    setInput("");
    setBusy(true);
    try {
      const r = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next, page: path }),
      });
      const j = await r.json();
      setMsgs([...next, { role: "assistant", content: j.reply || j.error || "Something went wrong." }]);
    } catch {
      setMsgs([...next, { role: "assistant", content: "I couldn't reach the assistant — check your connection and try again." }]);
    }
    setBusy(false);
  }

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-24 right-5 z-30 bg-brass hover:bg-brass-deep text-white rounded-full shadow-lg px-5 py-3 text-base font-semibold flex items-center gap-2 print:hidden"
          aria-label="Open help assistant"
        >
          <span aria-hidden="true">💬</span> Help
        </button>
      )}
      {open && (
        <div className="fixed bottom-5 right-5 z-30 w-[calc(100vw-2.5rem)] sm:w-[400px] h-[560px] max-h-[calc(100vh-2.5rem)] bg-paper-raised border border-line-strong rounded-xl shadow-2xl flex flex-col print:hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-line-strong">
            <div>
              <div className="font-display font-semibold text-lg">QuoteMe Help</div>
              <div className="text-xs text-ink-soft">Ask how anything in the app works</div>
            </div>
            <button onClick={() => setOpen(false)} className="text-2xl leading-none text-ink-soft hover:text-ink" aria-label="Close help">
              ×
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-sm">
            {msgs.length === 0 && (
              <div>
                <p className="text-ink-soft mb-3">Hi! I can help you use QuoteMe — reading plans, building quotes, variations, settings and more. Try one of these:</p>
                <div className="flex flex-col gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} onClick={() => send(s)} className="text-left border border-line-strong rounded-lg px-3 py-2 hover:bg-white">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div className={`max-w-[88%] rounded-lg px-3 py-2 whitespace-pre-wrap leading-relaxed ${m.role === "user" ? "bg-brass text-white" : "bg-white border border-line"}`}>{m.content}</div>
              </div>
            ))}
            {busy && <div className="text-ink-soft">Thinking…</div>}
            <div ref={end} />
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
            className="border-t border-line-strong p-3 flex gap-2"
          >
            <input
              className="flex-1 border border-line-strong rounded-md px-3 py-2 text-base bg-white"
              placeholder="Type your question…"
              value={input}
              maxLength={1000}
              onChange={(e) => setInput(e.target.value)}
            />
            <button disabled={busy || !input.trim()} className="bg-brass hover:bg-brass-deep text-white rounded-md px-4 py-2 text-base font-semibold disabled:opacity-50">
              Send
            </button>
          </form>
        </div>
      )}
    </>
  );
}

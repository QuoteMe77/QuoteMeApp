import Link from "next/link";

const FEATURES = [
  {
    icon: "📐",
    title: "Reads the drawings for you",
    text: "Upload the architect's or designer's drawings and QuoteMe measures the joinery, then shows exactly where on the drawing it found each item.",
  },
  {
    icon: "💰",
    title: "Shows where the money goes",
    text: "Every job's cost is split across material, hardware, factory, drafting, studio and install — with your markup and profit on top.",
  },
  {
    icon: "📁",
    title: "A folder for every project",
    text: "Each project gets its own folder: the quote, revisions, variations, PDF and Word copies and the drawings, all in one place.",
  },
];

const STEPS = [
  { n: "1", title: "Upload the drawings", text: "PDFs from the builder, architect or designer." },
  { n: "2", title: "Review the findings", text: "Check each item against the drawing and adjust where needed." },
  { n: "3", title: "Send the PDF quote", text: "A detailed PDF or Word quote, ready for your client." },
];

export default function HomePage() {
  return (
    <main className="min-h-screen px-4 sm:px-6 py-8 sm:py-12">
      <div className="max-w-5xl mx-auto">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/quoteme-hero.jpg"
          alt="QuoteMe — joinery quoting solutions"
          className="w-full rounded-2xl shadow-lg ring-1 ring-line-strong"
        />

        <div className="text-center mt-12">
          <h1 className="font-display text-3xl sm:text-5xl font-medium text-ink mb-4 leading-tight tracking-tight">
            Detailed joinery quotes,
            <br className="hidden sm:block" /> completed in minutes
          </h1>
          <p className="text-lg text-ink-soft mb-9 max-w-2xl mx-auto">
            Upload the drawings, review the findings from the read, and send the PDF quote — with the cost of every part of the job worked out.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center mb-3">
            <Link
              href="/signup"
              className="rounded-lg bg-brass hover:bg-brass-deep px-10 py-4 text-lg font-semibold text-white shadow-sm transition-colors"
            >
              Start free trial
            </Link>
            <Link
              href="/login"
              className="rounded-lg border-2 border-line-strong bg-paper-raised hover:border-brass px-10 py-4 text-lg font-semibold text-ink transition-colors"
            >
              Log in
            </Link>
          </div>
          <p className="text-sm text-ink-soft">14 days free, no card required</p>
        </div>

        <div className="grid sm:grid-cols-3 gap-5 mt-16">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl bg-paper-raised border border-line-strong p-6">
              <div className="w-11 h-11 rounded-lg flex items-center justify-center text-xl mb-4" style={{ background: "rgba(156,107,46,0.14)" }}>
                {f.icon}
              </div>
              <div className="font-display text-xl font-medium text-ink mb-1.5">{f.title}</div>
              <p className="text-sm text-ink-soft leading-relaxed">{f.text}</p>
            </div>
          ))}
        </div>

        <div className="mt-16 rounded-2xl bg-paper-raised border border-line-strong p-8">
          <h2 className="font-display text-center text-2xl font-medium text-ink mb-8">How it works</h2>
          <div className="grid sm:grid-cols-3 gap-8">
            {STEPS.map((s) => (
              <div key={s.n} className="text-center">
                <div className="mx-auto w-10 h-10 rounded-full bg-brass flex items-center justify-center font-semibold text-white mb-3">
                  {s.n}
                </div>
                <div className="font-display text-lg font-medium text-ink mb-1">{s.title}</div>
                <p className="text-sm text-ink-soft">{s.text}</p>
              </div>
            ))}
          </div>
        </div>

        <p className="text-center text-sm text-ink-soft mt-12">© QuoteMe · Joinery quoting solutions</p>
      </div>
    </main>
  );
}

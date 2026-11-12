import Link from "next/link";

const NAVY = "#0B1B33";
const BLUE = "#1E9BE8";

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
  { n: "2", title: "Review what was found", text: "Check every item against the drawing, and adjust." },
  { n: "3", title: "Send a detailed quote", text: "Professional PDF or Word, ready for your client." },
];

export default function HomePage() {
  return (
    <main className="min-h-screen px-4 sm:px-6 py-8 sm:py-12" style={{ background: `radial-gradient(1200px 600px at 50% -10%, #17315a 0%, ${NAVY} 60%)` }}>
      <div className="max-w-5xl mx-auto">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/quoteme-hero.jpg"
          alt="QuoteMe — joinery quoting solutions"
          className="w-full rounded-2xl shadow-2xl ring-1 ring-white/10"
        />

        <div className="text-center mt-12">
          <h1 className="text-3xl sm:text-5xl font-semibold text-white mb-4 leading-tight">
            Detailed joinery quotes,
            <br className="hidden sm:block" /> completed in minutes
          </h1>
          <p className="text-lg text-slate-300 mb-9 max-w-2xl mx-auto">
            Upload the drawings, check what QuoteMe found, and send a professional quote — with the cost of every part of the job worked out.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center mb-3">
            <Link
              href="/signup"
              className="rounded-lg px-10 py-4 text-lg font-semibold text-white shadow-lg transition-opacity hover:opacity-90"
              style={{ background: BLUE }}
            >
              Start free trial
            </Link>
            <Link
              href="/login"
              className="rounded-lg border-2 border-white/40 px-10 py-4 text-lg font-semibold text-white transition-colors hover:bg-white/10"
            >
              Log in
            </Link>
          </div>
          <p className="text-sm text-slate-400">14 days free, no card required</p>
        </div>

        <div className="grid sm:grid-cols-3 gap-5 mt-16">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl bg-white/5 ring-1 ring-white/10 p-6 backdrop-blur-sm">
              <div className="w-11 h-11 rounded-lg flex items-center justify-center text-xl mb-4" style={{ background: "rgba(30,155,232,0.18)" }}>
                {f.icon}
              </div>
              <div className="text-lg font-semibold text-white mb-1.5">{f.title}</div>
              <p className="text-sm text-slate-300 leading-relaxed">{f.text}</p>
            </div>
          ))}
        </div>

        <div className="mt-16 rounded-2xl bg-white/5 ring-1 ring-white/10 p-8">
          <h2 className="text-center text-xl font-semibold text-white mb-8">How it works</h2>
          <div className="grid sm:grid-cols-3 gap-8">
            {STEPS.map((s) => (
              <div key={s.n} className="text-center">
                <div className="mx-auto w-10 h-10 rounded-full flex items-center justify-center font-semibold text-white mb-3" style={{ background: BLUE }}>
                  {s.n}
                </div>
                <div className="font-semibold text-white mb-1">{s.title}</div>
                <p className="text-sm text-slate-300">{s.text}</p>
              </div>
            ))}
          </div>
        </div>

        <p className="text-center text-sm text-slate-500 mt-12">© QuoteMe · Joinery quoting solutions</p>
      </div>
    </main>
  );
}

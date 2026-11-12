import Link from "next/link";

const FEATURES = [
  { icon: "📐", title: "Read your plans", text: "Upload the drawings and QuoteMe measures the cabinetry for you — then shows exactly where on the plan it found each item." },
  { icon: "💲", title: "Price from your own price book", text: "Your rates, your markup. See where the money goes across material, hardware, factory, drafting and install." },
  { icon: "📁", title: "Every job in one folder", text: "Quotes, revisions, variations, PDFs and drawings together, with approvals and signatures." },
];

export default function HomePage() {
  return (
    <main className="min-h-screen bg-white flex flex-col items-center px-4 sm:px-6 py-8 sm:py-12">
      <div className="max-w-5xl w-full">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/quoteme-hero.jpg"
          alt="QuoteMe — joinery quoting solutions. More quotes. More opportunities."
          className="w-full rounded-2xl shadow-md"
        />
        <div className="text-center mt-10">
          <h1 className="text-3xl sm:text-4xl font-semibold mb-3" style={{ color: "#0B1B33" }}>
            Joinery quotes, done in minutes
          </h1>
          <p className="text-lg text-ink-soft mb-8 max-w-xl mx-auto">
            Price up a job, read a plan, send a quote — built for joinery businesses.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center mb-3">
            <Link
              href="/signup"
              className="rounded-lg px-10 py-4 text-lg font-semibold text-white shadow-sm transition-opacity hover:opacity-90"
              style={{ background: "#0B1B33" }}
            >
              Start free trial
            </Link>
            <Link
              href="/login"
              className="rounded-lg border-2 px-10 py-4 text-lg font-semibold transition-colors hover:bg-slate-50"
              style={{ borderColor: "#1E9BE8", color: "#0B1B33" }}
            >
              Log in
            </Link>
          </div>
          <p className="text-sm text-ink-soft mb-12">14 days free, no card required</p>
        </div>
        <div className="grid sm:grid-cols-3 gap-4 text-left">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
              <div className="text-2xl mb-2">{f.icon}</div>
              <div className="text-lg font-semibold mb-1" style={{ color: "#0B1B33" }}>{f.title}</div>
              <p className="text-sm text-ink-soft">{f.text}</p>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

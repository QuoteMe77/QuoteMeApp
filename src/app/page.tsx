import Link from "next/link";
import Logo from "@/components/Logo";

const FEATURES = [
  { icon: "📐", title: "Read your plans", text: "Upload the drawings and QuoteMe measures the cabinetry for you — then shows exactly where on the plan it found each item." },
  { icon: "💲", title: "Price from your own price book", text: "Your rates, your markup. See where the money goes across material, hardware, factory, drafting and install." },
  { icon: "📁", title: "Every job in one folder", text: "Quotes, revisions, variations, PDFs and drawings together, with approvals and signatures." },
];

export default function HomePage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 py-14">
      <div className="max-w-3xl w-full text-center">
        <Logo size={64} className="mb-5" />
        <h1 className="font-display text-3xl sm:text-4xl font-semibold text-ink mb-3">
          Joinery quotes, done in minutes
        </h1>
        <p className="text-lg text-ink-soft mb-9 max-w-xl mx-auto">
          Price up a job, read a plan, send a quote — built for joinery businesses.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center mb-3">
          <Link
            href="/signup"
            className="rounded-lg bg-brass hover:bg-brass-deep text-white px-8 py-4 text-lg font-semibold shadow-sm transition-colors"
          >
            Start free trial
          </Link>
          <Link
            href="/login"
            className="rounded-lg border-2 border-line-strong bg-paper-raised hover:border-brass px-8 py-4 text-lg font-semibold transition-colors"
          >
            Log in
          </Link>
        </div>
        <p className="text-sm text-ink-soft mb-14">14 days free, no card required</p>
        <div className="grid sm:grid-cols-3 gap-4 text-left">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-lg border border-line-strong bg-paper-raised p-5">
              <div className="text-2xl mb-2">{f.icon}</div>
              <div className="font-display text-lg font-semibold mb-1">{f.title}</div>
              <p className="text-sm text-ink-soft">{f.text}</p>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

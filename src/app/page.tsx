import Link from "next/link";

export default function HomePage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-lg w-full text-center">
        <h1 className="font-display text-4xl font-semibold text-brass-deep mb-3">
          QuoteMe
        </h1>
        <p className="text-ink-soft mb-10">
          Price up a job, read a plan, send a quote — built for joinery businesses.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <Link
            href="/signup"
            className="rounded-lg border border-line-strong bg-paper-raised px-6 py-8 hover:border-brass transition-colors"
          >
            <div className="font-display text-lg font-semibold">Start free trial</div>
            <div className="text-xs text-ink-soft mt-1">14 days, no card required</div>
          </Link>
          <Link
            href="/login"
            className="rounded-lg border border-line-strong bg-paper-raised px-6 py-8 hover:border-brass transition-colors"
          >
            <div className="font-display text-lg font-semibold">Log in</div>
            <div className="text-xs text-ink-soft mt-1">Already have an account</div>
          </Link>
        </div>
      </div>
    </main>
  );
}

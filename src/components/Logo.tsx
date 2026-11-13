// QuoteMe mark: a brass tile with a quote sheet and a tick, plus the wordmark.
export default function Logo({ size = 44, wordmark = true, className = "" }: { size?: number; wordmark?: boolean; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-3 ${className}`}>
      <svg width={size} height={size} viewBox="0 0 44 44" aria-hidden="true">
        <rect x="2" y="2" width="40" height="40" rx="10" fill="#0B1B33" />
        <path d="M13 14h18v4H13zM13 20h12v4H13zM13 26h18v4H13z" fill="#fff" opacity="0.92" />
        <circle cx="32" cy="29" r="5" fill="#1E9BE8" />
        <path d="M30 29l1.6 1.6L34.4 27" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {wordmark && <span className="font-display font-semibold tracking-tight text-ink" style={{ fontSize: size * 0.8 }}>QuoteMe</span>}
    </span>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/dashboard/settings/business", label: "Business setup" },
  { href: "/dashboard/settings/price-book", label: "Price book & costs" },
  { href: "/dashboard/settings/terms", label: "Terms & conditions" },
];

export default function SettingsTabs() {
  const path = usePathname();
  return (
    <div className="flex gap-1 border-b border-line-strong mb-6">
      {TABS.map((t) => {
        const active = path.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`px-4 py-2.5 text-base -mb-px border-b-2 ${active ? "border-brass text-ink font-semibold" : "border-transparent text-ink-soft hover:text-ink"}`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}

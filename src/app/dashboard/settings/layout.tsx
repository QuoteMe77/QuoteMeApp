import SettingsTabs from "./SettingsTabs";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-6xl mx-auto">
      <h2 className="font-display text-2xl font-semibold mb-1">Settings</h2>
      <p className="text-ink-soft text-sm mb-5">Set up your rates, costs and terms. Changes apply to new quotes straight away.</p>
      <SettingsTabs />
      {children}
    </div>
  );
}

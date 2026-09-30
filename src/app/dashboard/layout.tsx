import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import SignOutButton from "./SignOutButton";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  console.log("[dashboard-layout] getUser", { hasUser: !!user, userError: userError?.message ?? null });
  if (!user) redirect("/login");

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("org_id, full_name")
    .eq("id", user.id)
    .single();

  console.log("[dashboard-layout] profile lookup", {
    userId: user.id,
    hasProfile: !!profile,
    profileError: profileError?.message ?? null,
  });

  if (!profile) redirect("/login");

  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select("id, name, subscription_status, trial_ends_at")
    .eq("id", profile.org_id)
    .single();

  console.log("[dashboard-layout] org lookup", { orgId: profile.org_id, hasOrg: !!org, orgError: orgError?.message ?? null });

  const trialExpired =
    org?.subscription_status === "trialing" &&
    org?.trial_ends_at &&
    new Date(org.trial_ends_at) < new Date();
  const blocked = trialExpired || org?.subscription_status === "canceled" || org?.subscription_status === "past_due";

  return (
    <div className="min-h-screen">
      <header className="border-b border-line-strong bg-paper px-5 py-3 flex items-center gap-4">
        <h1 className="font-display text-lg font-semibold">QuoteMe</h1>
        <span className="text-ink-soft text-sm flex-1">{org?.name}</span>
        {org?.subscription_status === "trialing" && !trialExpired && (
          <span className="text-xs text-brass-deep">
            Trial — ends {new Date(org.trial_ends_at!).toLocaleDateString()}
          </span>
        )}
        {org?.subscription_status === "active" && (
          <form action="/api/stripe/portal" method="POST">
            <button type="submit" className="text-xs text-ink-soft underline">
              Manage billing
            </button>
          </form>
        )}
        <SignOutButton />
      </header>

      {blocked ? (
        <BillingGate orgId={org!.id} status={org!.subscription_status} />
      ) : (
        <main className="p-5">{children}</main>
      )}
    </div>
  );
}

function BillingGate({ orgId, status }: { orgId: string; status: string }) {
  return (
    <div className="max-w-md mx-auto mt-24 text-center bg-paper-raised border border-line-strong rounded-lg p-8">
      <h2 className="font-display text-xl font-semibold mb-2">
        {status === "past_due" ? "Payment needs attention" : "Your trial has ended"}
      </h2>
      <p className="text-ink-soft text-sm mb-6">
        Start a subscription to keep quoting — your price book and saved quotes are all still here.
      </p>
      <form action="/api/stripe/checkout" method="POST">
        <input type="hidden" name="org_id" value={orgId} />
        <button
          type="submit"
          className="bg-brass hover:bg-brass-deep text-white rounded-md px-6 py-2.5 font-medium"
        >
          Subscribe
        </button>
      </form>
    </div>
  );
}

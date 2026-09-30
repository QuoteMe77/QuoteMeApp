import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/server";

// Route handlers read the raw body themselves for signature verification,
// so this must not be parsed as JSON by the framework.
export const runtime = "nodejs";

/**
 * Stripe sends events here as a subscription's state changes. This is the
 * only place that actually flips an organization's subscription_status —
 * the checkout route just starts the flow, this route is what unlocks the
 * dashboard once Stripe confirms payment (or locks it again on cancellation
 * or failure).
 *
 * Configure this endpoint's URL in the Stripe Dashboard (or via the CLI for
 * local testing) as: POST https://<your-domain>/api/stripe/webhook
 * and put the signing secret it gives you into STRIPE_WEBHOOK_SECRET.
 */
export async function POST(request: NextRequest) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Stripe webhook signature verification failed:", message);
    return NextResponse.json({ error: `Webhook signature verification failed: ${message}` }, { status: 400 });
  }

  const supabase = createAdminClient();

  try {
    switch (event.type) {
      // Checkout finished — the subscription now exists on Stripe's side.
      // We still wait for customer.subscription.updated to set the final
      // status, but this is the most reliable place to persist the
      // subscription id and org linkage right away.
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const orgId = session.metadata?.org_id;
        if (orgId && session.subscription) {
          const subscriptionId =
            typeof session.subscription === "string" ? session.subscription : session.subscription.id;
          await supabase
            .from("organizations")
            .update({ stripe_subscription_id: subscriptionId })
            .eq("id", orgId);
        }
        break;
      }

      // Fires on creation, plan changes, renewals, payment failures, etc.
      // subscription.status is the source of truth for gating access.
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const orgId = subscription.metadata?.org_id ?? (await findOrgByCustomerId(supabase, subscription.customer));
        if (orgId) {
          await supabase
            .from("organizations")
            .update({
              stripe_subscription_id: subscription.id,
              subscription_status: mapStripeStatus(subscription.status),
            })
            .eq("id", orgId);
        }
        break;
      }

      // Subscription fully cancelled (immediately, or at period end once it lapses).
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const orgId = subscription.metadata?.org_id ?? (await findOrgByCustomerId(supabase, subscription.customer));
        if (orgId) {
          await supabase
            .from("organizations")
            .update({ subscription_status: "canceled" })
            .eq("id", orgId);
        }
        break;
      }

      // A renewal payment failed. Stripe will retry per its own schedule;
      // we just reflect the failure so the billing gate can show it.
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer;
        const orgId = await findOrgByCustomerId(supabase, customerId);
        if (orgId) {
          await supabase.from("organizations").update({ subscription_status: "past_due" }).eq("id", orgId);
        }
        break;
      }

      default:
        // Ignore anything we don't explicitly handle.
        break;
    }
  } catch (err) {
    console.error(`Error handling Stripe webhook event ${event.type}:`, err);
    // Returning 500 makes Stripe retry the event later.
    return NextResponse.json({ error: "Webhook handler failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

/** Maps a Stripe subscription status onto the small enum our schema uses. */
function mapStripeStatus(status: Stripe.Subscription.Status): "trialing" | "active" | "past_due" | "canceled" {
  switch (status) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
    case "unpaid":
    case "incomplete":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
    case "paused":
      return "canceled";
    default:
      return "past_due";
  }
}

/** Fallback lookup for events that don't carry org_id in their own metadata. */
async function findOrgByCustomerId(
  supabase: ReturnType<typeof createAdminClient>,
  customerId: string | Stripe.Customer | Stripe.DeletedCustomer | null
): Promise<string | null> {
  if (!customerId) return null;
  const id = typeof customerId === "string" ? customerId : customerId.id;
  const { data } = await supabase.from("organizations").select("id").eq("stripe_customer_id", id).single();
  return data?.id ?? null;
}

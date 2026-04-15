/**
 * StripeService — Stripe Checkout + Customer Portal + Webhook handling
 */
import { db } from '../../db/client.js';
import { subscriptions, users } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { getEnv } from '../../config/env.js';

// Dynamic import to avoid hard dependency if Stripe SDK not installed
let stripe: import('stripe').default | null = null;

async function getStripe(): Promise<import('stripe').default> {
  if (stripe) return stripe;

  const env = getEnv();
  const key = env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY not configured. Set it in environment variables.');
  }

  const Stripe = (await import('stripe')).default;
  stripe = new Stripe(key, { apiVersion: '2025-04-30.basil' as import('stripe').Stripe.LatestApiVersion });
  return stripe;
}

export interface CheckoutResult {
  sessionId: string;
  url: string;
}

/**
 * Create a Stripe Checkout session for plan upgrade
 */
export async function createCheckoutSession(
  userId: string,
  planId: string,
  priceId: string,
  successUrl: string,
  cancelUrl: string,
): Promise<CheckoutResult> {
  const s = await getStripe();

  // Get or create Stripe customer
  const existingSub = await db
    .select({ stripeCustomerId: subscriptions.stripeCustomerId })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);

  let customerId = existingSub[0]?.stripeCustomerId;

  if (!customerId) {
    // Get user email for customer creation
    const [user] = await db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
    const customer = await s.customers.create({
      email: user?.email ?? undefined,
      name: user?.name ?? undefined,
      metadata: { userId, planId },
    });
    customerId = customer.id;
  }

  const session = await s.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { userId, planId },
    subscription_data: {
      metadata: { userId, planId },
    },
  });

  return {
    sessionId: session.id,
    url: session.url!,
  };
}

/**
 * Create a Stripe Customer Portal session (for managing subscription)
 */
export async function createPortalSession(userId: string, returnUrl: string): Promise<string> {
  const s = await getStripe();

  const [sub] = await db
    .select({ stripeCustomerId: subscriptions.stripeCustomerId })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);

  if (!sub?.stripeCustomerId) {
    throw new Error('No Stripe customer found for this user.');
  }

  const session = await s.billingPortal.sessions.create({
    customer: sub.stripeCustomerId,
    return_url: returnUrl,
  });

  return session.url;
}

/**
 * Handle Stripe webhook events
 */
export async function handleWebhookEvent(
  rawBody: Buffer,
  signature: string,
): Promise<{ handled: boolean; eventType: string }> {
  const s = await getStripe();
  const env = getEnv();

  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET not configured');
  }

  const event = s.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      const planId = session.metadata?.planId;
      const stripeCustomerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
      const stripeSubscriptionId = typeof session.subscription === 'string' ? session.subscription : (session.subscription as { id: string })?.id;

      if (userId && planId && stripeCustomerId) {
        // Upsert subscription
        const existing = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1);

        if (existing.length > 0) {
          await db.update(subscriptions)
            .set({
              planId,
              status: 'active',
              stripeCustomerId,
              stripeSubscriptionId: stripeSubscriptionId ?? null,
              updatedAt: new Date(),
            })
            .where(eq(subscriptions.userId, userId));
        } else {
          await db.insert(subscriptions).values({
            userId,
            planId,
            status: 'active',
            stripeCustomerId,
            stripeSubscriptionId: stripeSubscriptionId ?? null,
          });
        }
      }
      break;
    }

    case 'invoice.paid': {
      const invoice = event.data.object;
      const stripeCustomerId = typeof invoice.customer === 'string' ? invoice.customer : null;
      if (stripeCustomerId) {
        // Update period dates
        const periodEnd = invoice.lines?.data?.[0]?.period?.end;
        if (periodEnd) {
          await db.update(subscriptions)
            .set({
              currentPeriodEnd: new Date(periodEnd * 1000),
              status: 'active',
              updatedAt: new Date(),
            })
            .where(eq(subscriptions.stripeCustomerId, stripeCustomerId));
        }
      }
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const stripeSubId = sub.id;
      const status = sub.status === 'active' ? 'active' :
                     sub.status === 'past_due' ? 'past_due' :
                     sub.status === 'trialing' ? 'trialing' :
                     sub.status === 'incomplete' ? 'incomplete' : 'canceled';

      await db.update(subscriptions)
        .set({
          status,
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          currentPeriodStart: new Date(((sub as unknown as Record<string, number>).current_period_start) * 1000),
          currentPeriodEnd: new Date(((sub as unknown as Record<string, number>).current_period_end) * 1000),
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.stripeSubscriptionId, stripeSubId));
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const stripeSubId = sub.id;

      await db.update(subscriptions)
        .set({
          status: 'canceled',
          updatedAt: new Date(),
        })
        .where(eq(subscriptions.stripeSubscriptionId, stripeSubId));
      break;
    }

    default:
      return { handled: false, eventType: event.type };
  }

  return { handled: true, eventType: event.type };
}

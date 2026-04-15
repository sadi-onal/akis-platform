/**
 * Billing API routes
 * - GET /api/billing/plan — current user plan + usage
 * - GET /api/billing/plans — all available plans (public)
 * - GET /api/billing/settings — workspace billing settings (admin)
 * - PUT /api/billing/settings — update workspace billing settings (admin)
 * - GET /api/billing/notifications — user billing notifications
 * - PUT /api/billing/user-override/:userId — set per-user override (admin)
 * - POST /api/billing/checkout — create Stripe checkout session
 * - POST /api/billing/portal — create Stripe customer portal session
 */
import { FastifyInstance } from 'fastify';
import { requireAuth, requireAdmin } from '../utils/auth.js';
import { formatErrorResponse } from '../utils/errorHandler.js';
import {
  getUserPlan,
  getUsageSummary,
  getAvailablePlans,
  getWorkspaceBillingSettings,
  updateWorkspaceBillingSettings,
  getUserOverride,
  setUserOverride,
  getNotifications,
  isUserUnlimited,
} from '../services/billing/BillingService.js';
import {
  createCheckoutSession,
  createPortalSession,
  handleWebhookEvent,
} from '../services/billing/StripeService.js';
import { getEnv } from '../config/env.js';
import { logger } from '../lib/logger.js';

export async function billingRoutes(fastify: FastifyInstance) {
  // GET /api/billing/plan — current user's plan and usage
  fastify.get('/api/billing/plan', async (request, reply) => {
    try {
      const user = await requireAuth(request);
      const [plan, usage, unlimited] = await Promise.all([
        getUserPlan(user.id),
        getUsageSummary(user.id),
        isUserUnlimited(user.id),
      ]);

      return reply.send({ plan, usage, unlimited, role: user.role });
    } catch (error) {
      const errorResponse = formatErrorResponse(request, error);
      return reply.code(401).send(errorResponse);
    }
  });

  // GET /api/billing/plans — all available plans
  fastify.get('/api/billing/plans', async (_request, reply) => {
    const allPlans = await getAvailablePlans();
    return reply.send({ plans: allPlans });
  });

  // GET /api/billing/settings — workspace billing settings (admin-only)
  fastify.get('/api/billing/settings', async (request, reply) => {
    try {
      await requireAdmin(request);
      const settings = await getWorkspaceBillingSettings();
      return reply.send(settings);
    } catch (error) {
      if ((error as Error).message === 'FORBIDDEN') {
        return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Admin access required' } });
      }
      const errorResponse = formatErrorResponse(request, error);
      return reply.code(401).send(errorResponse);
    }
  });

  // PUT /api/billing/settings — update workspace billing settings (admin-only)
  fastify.post('/api/billing/settings', async (request, reply) => {
    try {
      await requireAdmin(request);
      const body = request.body as {
        monthlyBudgetUsd?: number | null;
        softThresholdPct?: number;
        hardStopEnabled?: boolean;
      };
      const settings = await updateWorkspaceBillingSettings(body);
      return reply.send(settings);
    } catch (error) {
      if ((error as Error).message === 'FORBIDDEN') {
        return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Admin access required' } });
      }
      const errorResponse = formatErrorResponse(request, error);
      return reply.code(500).send(errorResponse);
    }
  });

  // GET /api/billing/notifications — user's billing notifications
  fastify.get('/api/billing/notifications', async (request, reply) => {
    try {
      const user = await requireAuth(request);
      const notifications = await getNotifications(user.id);
      return reply.send({ notifications });
    } catch (error) {
      const errorResponse = formatErrorResponse(request, error);
      return reply.code(401).send(errorResponse);
    }
  });

  // POST /api/billing/user-override — set per-user billing override (admin-only)
  fastify.post('/api/billing/user-override', async (request, reply) => {
    try {
      await requireAdmin(request);
      const body = request.body as {
        userId: string;
        monthlyBudgetUsd?: number | null;
        isUnlimited?: boolean;
      };

      if (!body.userId) {
        return reply.code(400).send({ error: { code: 'MISSING_FIELDS', message: 'userId is required' } });
      }

      await setUserOverride(body.userId, {
        monthlyBudgetUsd: body.monthlyBudgetUsd,
        isUnlimited: body.isUnlimited,
      });

      const override = await getUserOverride(body.userId);
      return reply.send({ override });
    } catch (error) {
      if ((error as Error).message === 'FORBIDDEN') {
        return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Admin access required' } });
      }
      const errorResponse = formatErrorResponse(request, error);
      return reply.code(500).send(errorResponse);
    }
  });

  // POST /api/billing/checkout — create Stripe checkout session
  fastify.post('/api/billing/checkout', async (request, reply) => {
    try {
      const env = getEnv();
      if (env.STRIPE_SECRET_KEY === 'sk_test_placeholder') {
        return reply.code(503).send({
          error: { code: 'PAYMENTS_DISABLED', message: 'Payment processing is not configured' },
        });
      }

      const user = await requireAuth(request);
      const body = request.body as { planId: string; priceId: string };

      if (!body.planId || !body.priceId) {
        return reply.code(400).send({
          error: { code: 'MISSING_FIELDS', message: 'planId and priceId are required' },
        });
      }

      const frontendUrl = env.FRONTEND_URL || 'http://localhost:5173';
      const result = await createCheckoutSession(
        user.id,
        body.planId,
        body.priceId,
        `${frontendUrl}/dashboard/settings/billing?session_id={CHECKOUT_SESSION_ID}&status=success`,
        `${frontendUrl}/dashboard/settings/billing?status=canceled`,
      );

      return reply.send(result);
    } catch (error) {
      logger.error(`[Billing] Checkout error: ${error}`);
      const errorResponse = formatErrorResponse(request, error);
      return reply.code(500).send(errorResponse);
    }
  });

  // POST /api/billing/portal — create Stripe customer portal session
  fastify.post('/api/billing/portal', async (request, reply) => {
    try {
      const user = await requireAuth(request);
      const env = getEnv();
      const frontendUrl = env.FRONTEND_URL || 'http://localhost:5173';

      const url = await createPortalSession(
        user.id,
        `${frontendUrl}/dashboard/settings/billing`,
      );

      return reply.send({ url });
    } catch (error) {
      logger.error(`[Billing] Portal error: ${error}`);
      const errorResponse = formatErrorResponse(request, error);
      return reply.code(500).send(errorResponse);
    }
  });
}

/**
 * Stripe webhook routes (separate from billing routes - different auth)
 */
export async function stripeWebhookRoutes(fastify: FastifyInstance) {
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    ((_req: unknown, body: unknown, done: (err: null, result: unknown) => void) => { done(null, body); }) as (...args: unknown[]) => unknown,
  );

  fastify.post('/api/webhooks/stripe', async (request, reply) => {
    const signature = request.headers['stripe-signature'] as string;
    if (!signature) {
      return reply.code(400).send({ error: 'Missing stripe-signature header' });
    }

    try {
      const rawBody = request.body as Buffer;
      const result = await handleWebhookEvent(rawBody, signature);

      if (result.handled) {
        logger.info(`[Stripe] Handled webhook: ${result.eventType}`);
      }

      return reply.send({ received: true });
    } catch (error) {
      logger.error(`[Stripe] Webhook error: ${error}`);
      return reply.code(400).send({
        error: error instanceof Error ? error.message : 'Webhook processing failed',
      });
    }
  });
}

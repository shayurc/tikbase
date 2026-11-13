// Creates a Stripe Checkout Session for a subscription.
// This is the replacement for raw Payment Link URLs: everything that used to
// live in the Stripe Payment Link dashboard config (success URL, cancel URL,
// promo codes, client_reference_id) is now in code — one-time setup, no more
// dashboard clicks when adding new plans.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { ACTIVE_STATUSES } from './_lib/resolve-tier.js';
import { appleRecordActive } from './_lib/apple-subscription.js';

// Hardcoded live Stripe price IDs. Add new plans here.
const PRICE_IDS: Record<string, string> = {
  monthly: 'price_1THHz2CmsZejQhLSRBkSjObx', // $44.99 / month
  annual: 'price_1THHz3CmsZejQhLScuVuKg8o', // $377.88 / year
};

/**
 * Look up a human-readable promo code and return either a `discounts` arg
 * with the resolved promotion_code id, or fall back to allow_promotion_codes
 * if the code doesn't exist (so the user can correct it on Stripe's page).
 */
async function resolvePromoCode(
  stripe: Stripe,
  code: string,
): Promise<Partial<Stripe.Checkout.SessionCreateParams>> {
  try {
    const list = await stripe.promotionCodes.list({
      code,
      active: true,
      limit: 1,
    });
    const found = list.data[0];
    if (found) return { discounts: [{ promotion_code: found.id }] };
  } catch {
    /* swallow — fall through */
  }
  return { allow_promotion_codes: true };
}

function getBaseUrl(req: VercelRequest): string {
  // Prefer explicit env, fall back to request host.
  if (process.env.APP_URL) return process.env.APP_URL;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  // Vercel always sends x-forwarded-proto. The dev server (which now runs this
  // handler rather than a hand-kept copy) does not, and Stripe has to send the
  // buyer back to http://localhost, not https.
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(String(host));
  const proto = (req.headers['x-forwarded-proto'] as string) || (local ? 'http' : 'https');
  return `${proto}://${host}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { plan, email, promo_code } = (req.body ?? {}) as {
      plan?: 'monthly' | 'annual';
      email?: string;
      promo_code?: string;
    };

    if (!plan || !PRICE_IDS[plan]) {
      return res.status(400).json({ error: 'Invalid or missing plan' });
    }

    // Identify the caller from the verified access token — never trust a
    // client-supplied user_id, which is written into the subscription metadata.
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({ error: 'Supabase env vars missing' });
    }
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authData.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const user_id = authData.user.id;

    // One subscription per account, enforced here because here is the only
    // place it cannot be clicked around. The Plans page offered "Upgrade to
    // Pro" to people already paying (it never read the tier), and the app
    // shows a paying customer as free whenever the subscription check fails —
    // so a second checkout was one click away: a new Stripe customer, a second
    // charge, and a subscription the billing portal (which opens the FIRST
    // customer) never shows them.
    //
    // If the plan cannot be read, refuse rather than guess: asking a buyer to
    // try again costs a minute, a double charge costs a refund and their trust.
    const { data: existing, error: existingErr } =
      await supabase.auth.admin.getUserById(user_id);
    if (existingErr || !existing?.user) {
      console.error('create-checkout-session: could not read current plan:', existingErr?.message);
      res.setHeader('Retry-After', '30');
      return res.status(503).json({
        error: 'plan_check_failed',
        message: 'We could not check your current plan. Nothing was charged — please try again in a moment.',
      });
    }
    const currentStatus = (existing.user.app_metadata as any)?.subscription?.status;
    if (currentStatus && ACTIVE_STATUSES.has(currentStatus)) {
      return res.status(409).json({
        error: 'already_subscribed',
        message: 'You already have TikBase Pro. Manage your subscription from Billing.',
      });
    }

    // Already Pro through the iPhone app: a web checkout would bill them twice
    // for the same thing, once by Apple and once by Stripe.
    if (appleRecordActive((existing.user.app_metadata as any)?.apple_subscription)) {
      return res.status(409).json({
        error: 'already_subscribed',
        message:
          'You already have TikBase Pro through the iPhone app. Manage it in your Apple Account settings.',
      });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    const baseUrl = getBaseUrl(req);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],

      // This is the critical bit: ties the checkout to the Supabase user.
      // The webhook reads this back off checkout.session.completed.
      client_reference_id: user_id,
      metadata: { supabase_user_id: user_id },
      subscription_data: {
        metadata: { supabase_user_id: user_id },
      },

      // Prefill but let the user change it — Stripe customer email is
      // decorative now; user_id is what matters.
      ...(email ? { customer_email: email } : {}),

      // Wouter hash routing: session_id lives in window.location.search
      // (before the `#`), which the success page reads on mount.
      success_url: `${baseUrl}/?session_id={CHECKOUT_SESSION_ID}#/subscription-success`,
      cancel_url: `${baseUrl}/#/dashboard/plans`,

      // If the user typed a promo code in the paywall modal, look it up by its
      // human-readable code to get the promotion_code ID Stripe expects in `discounts`.
      // Fall back to allow_promotion_codes so they can enter one on Stripe's page.
      ...(promo_code
        ? await resolvePromoCode(stripe, promo_code)
        : { allow_promotion_codes: true }),
    });

    return res.json({ url: session.url });
  } catch (err: any) {
    console.error('create-checkout-session error:', err.message);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
}

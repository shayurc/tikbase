import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
// This import was missing from 2026-08-15 and found on 2026-11-12. Nothing caught it:
// api/ was outside tsconfig's include, the deploy only logs type errors, and
// the smoke test sends no token, which returns before the first use. In
// production every expired token and every database blip threw a
// ReferenceError here — and again in the catch block — so the endpoint
// answered 500 instead of isPaid:false or the 503 this file exists to send.
import { isUpstreamOutage, unavailable } from './_lib/upstream.js';

// Vercel's @vercel/node builder doesn't bundle TS files outside api/ into the
// function bundle, so shared helpers are inlined here (and in the other api/*
// handlers). Kept small on purpose.

const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);
// Re-check Stripe at most once an hour for a user with no active sub, so free
// users don't trigger a Stripe lookup on every single app load.
const RECONCILE_THROTTLE_MS = 60 * 60 * 1000;

function snapshot(sub: Stripe.Subscription) {
  const item = sub.items.data[0];
  const cpe =
    (item as any)?.current_period_end ?? (sub as any).current_period_end ?? null;
  return {
    status: sub.status,
    stripe_customer_id:
      typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
    stripe_subscription_id: sub.id,
    price_id: item?.price?.id ?? null,
    current_period_end: cpe ? new Date(cpe * 1000).toISOString() : null,
    cancel_at_period_end: sub.cancel_at_period_end ?? false,
    updated_at: new Date().toISOString(),
  };
}

// Layer B: reconcile-at-login safety net.
// The webhook links the vast majority of purchases. But a Payment Link paid
// before signup (or with an email that doesn't match the account) can leave a
// paying customer with no linked subscription — they're stuck on the free tier.
// When such a user loads the app, look Stripe up by their account email and
// self-heal. Idempotent: only runs when there's no stored active sub, and
// re-writes the same snapshot if run again. Logs when it fires.
async function reconcileFromStripe(
  supabase: SupabaseClient,
  user: { id: string; email?: string; app_metadata?: Record<string, any> },
): Promise<ReturnType<typeof snapshot> | null> {
  const email = user.email;
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!email || !secret) return null;
  const stripe = new Stripe(secret);

  const custs = await stripe.customers.list({ email, limit: 10 });
  let sub: Stripe.Subscription | null = null;
  for (const c of custs.data) {
    const subs = await stripe.subscriptions.list({
      customer: c.id,
      status: 'all',
      limit: 10,
    });
    const active = subs.data.find((s) => ACTIVE_STATUSES.has(s.status));
    if (active) {
      sub = active;
      break;
    }
  }
  if (!sub) return null;

  const snap = snapshot(sub);
  const prev = user.app_metadata || {};
  await supabase.auth.admin.updateUserById(user.id, {
    app_metadata: {
      ...prev,
      subscription: snap,
      reconcile_checked_at: new Date().toISOString(),
    },
  });
  // Backfill Stripe metadata + close any orphan record for this subscription.
  await stripe.subscriptions
    .update(sub.id, {
      metadata: { ...(sub.metadata || {}), supabase_user_id: user.id },
    })
    .catch(() => {});
  await supabase
    .from('billing_orphans')
    .update({
      status: 'resolved',
      resolved_user_id: user.id,
      resolved_at: new Date().toISOString(),
    })
    .eq('stripe_subscription_id', sub.id)
    .then(undefined, () => {});
  console.log(
    `[reconcile] self-healed access for user ${user.id} via email ${email} → ${sub.id} (${sub.status})`,
  );
  return snap;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // Derive the user from the verified access token — never trust a
    // client-supplied user_id (that would let anyone read any user's status).
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    // Nobody signed in is an answer, and needs no backend to give.
    if (!token) return res.json({ isPaid: false });

    // Missing configuration used to answer isPaid:false here — every paying
    // customer told they are not paying because an environment variable was
    // dropped in a deploy. That is "could not ask", so it is a 503, the same as
    // an unreachable database.
    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      console.error('check-subscription: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
      return serveUnavailable(res);
    }

    const supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    // A token we cannot CHECK is different from a token that is invalid. Only
    // the second one means "free".
    if (authError && isUpstreamOutage(authError)) return serveUnavailable(res);
    if (authError || !authData.user) return res.json({ isPaid: false });
    const userId = authData.user.id;

    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error && isUpstreamOutage(error)) return serveUnavailable(res);
    if (error || !data.user) return res.json({ isPaid: false });

    const meta = (data.user.app_metadata as Record<string, any>) || {};
    let sub = meta.subscription;

    // Layer B: if not already paid, attempt a throttled self-heal from Stripe.
    if (!(sub?.status && ACTIVE_STATUSES.has(sub.status))) {
      const last = meta.reconcile_checked_at
        ? Date.parse(meta.reconcile_checked_at)
        : 0;
      if (Date.now() - last > RECONCILE_THROTTLE_MS) {
        const healed = await reconcileFromStripe(supabase, {
          id: userId,
          email: data.user.email,
          app_metadata: meta,
        });
        if (healed) {
          sub = healed;
        } else {
          // Stamp the throttle timestamp so we don't hit Stripe every load.
          await supabase.auth.admin
            .updateUserById(userId, {
              app_metadata: { ...meta, reconcile_checked_at: new Date().toISOString() },
            })
            .catch(() => {});
        }
      }
    }

    const isPaid = !!sub?.status && ACTIVE_STATUSES.has(sub.status);

    // Referral attribution, surfaced for whoever ends up owning payouts. It is
    // read from user_metadata (the signup writes it there) and echoed only to
    // the authenticated owner of the account — this endpoint already derives
    // the user from a verified token, so there is nobody else to leak it to.
    const referral = (data.user.user_metadata as Record<string, any> | null)?.referral;
    return res.json({
      isPaid,
      ...(referral?.code
        ? {
            referral: {
              code: String(referral.code),
              param: referral.param ?? null,
              landedAt: referral.landedAt ?? null,
              signedUpAt: data.user.created_at ?? null,
            },
          }
        : {}),
    });
  } catch (err: any) {
    console.error('check-subscription exception:', err?.message);
    // The whole point: a paying customer must never be told isPaid:false
    // because the database was unreachable.
    if (isUpstreamOutage(err)) return serveUnavailable(res);
    return res.json({ isPaid: false });
  }
}

function serveUnavailable(res: VercelResponse) {
  const u = unavailable();
  res.setHeader('Retry-After', u.retryAfter);
  res.setHeader('Cache-Control', 'no-store');
  console.error('check-subscription: upstream unreachable — answering 503 rather than isPaid:false');
  return res.status(u.status).json(u.body);
}

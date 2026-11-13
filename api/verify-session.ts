// Success-page companion: retrieves the Stripe Checkout Session and upserts
// the subscription snapshot into auth.users.app_metadata.
// Helpers inlined — see api/check-subscription.ts for context.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

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

async function writeSnapshot(
  supabase: any,
  userId: string,
  sub: Stripe.Subscription,
) {
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data.user) throw new Error(`User ${userId} not found`);
  const prev = (data.user.app_metadata as Record<string, any>) || {};
  const { error: updErr } = await supabase.auth.admin.updateUserById(userId, {
    app_metadata: { ...prev, subscription: snapshot(sub) },
  });
  if (updErr) throw new Error(`Failed to update user: ${updErr.message}`);
}

export type OwnerDecision =
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Which account a paid checkout belongs to.
 *
 * This endpoint used to take `user_id` from an unauthenticated request body and
 * write the subscription to it. The only guard was "if the session carries a
 * client_reference_id, it must match" — so for a session that carries none
 * (every Stripe Payment Link), anyone holding the session id could attach the
 * subscription to any account, as many times as they liked. Each claim also
 * restamped the subscription's metadata, so a later cancellation only reached
 * the newest claimant and every earlier account kept a snapshot saying
 * 'active' forever.
 *
 * The account is now decided by records the request cannot forge:
 *
 *   stampedUserId  create-checkout-session writes it from a verified token. If
 *                  it is there, the subscription goes to that account and to
 *                  no other. The caller only has to name the same account;
 *                  what they send is compared, never written.
 *   no stamp       (Payment Link.) A verified bearer token is required, and
 *                  the first signed-in claim wins: once the subscription is
 *                  linked, nobody else can take it.
 *
 * One payment, one account. Pure, so every branch is tested.
 */
export function resolveSessionOwner(input: {
  /** session.client_reference_id, else session.metadata.supabase_user_id. */
  stampedUserId: string | null;
  /** subscription.metadata.supabase_user_id — set the first time it is linked. */
  linkedUserId: string | null;
  /** From a verified bearer token; null when there was no valid one. */
  callerId: string | null;
  /** `user_id` from the body, as sent by clients from before 2026-11. */
  legacyUserId: string | null;
}): OwnerDecision {
  const { stampedUserId, linkedUserId, callerId, legacyUserId } = input;
  const signIn: OwnerDecision = {
    ok: false,
    status: 401,
    error: 'Sign in to confirm this purchase',
  };
  const taken: OwnerDecision = {
    ok: false,
    status: 403,
    error: 'This subscription is already linked to another account',
  };

  if (stampedUserId) {
    const claimed = callerId ?? legacyUserId;
    if (!claimed) return signIn;
    if (claimed !== stampedUserId) {
      return { ok: false, status: 403, error: 'Session does not belong to this user' };
    }
    if (linkedUserId && linkedUserId !== stampedUserId) return taken;
    return { ok: true, userId: stampedUserId };
  }

  if (!callerId) return signIn;
  if (linkedUserId && linkedUserId !== callerId) return taken;
  return { ok: true, userId: callerId };
}

/** The caller's user id from a verified bearer token, or null. */
async function callerIdFromToken(
  req: VercelRequest,
  supabase: SupabaseClient,
): Promise<string | null> {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { session_id, user_id } = (req.body ?? {}) as {
      session_id?: string;
      user_id?: string;
    };
    if (!session_id) {
      return res.status(400).json({ error: 'session_id is required' });
    }

    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Supabase env vars missing');
    const supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    // Expanded so the subscription's own metadata (who it is linked to) is in
    // hand before deciding anything, and so there is no second retrieve.
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['subscription'],
    });
    const sub: Stripe.Subscription | null =
      typeof session.subscription === 'string'
        ? await stripe.subscriptions.retrieve(session.subscription)
        : session.subscription ?? null;

    const owner = resolveSessionOwner({
      stampedUserId:
        session.client_reference_id || session.metadata?.supabase_user_id || null,
      linkedUserId: sub?.metadata?.supabase_user_id || null,
      callerId: await callerIdFromToken(req, supabase),
      legacyUserId: typeof user_id === 'string' && user_id ? user_id : null,
    });
    if (!owner.ok) return res.status(owner.status).json({ error: owner.error });

    if (session.payment_status !== 'paid' && session.status !== 'complete') {
      return res.json({ isPaid: false, status: session.status });
    }
    if (!sub) {
      return res.json({ isPaid: false, reason: 'no_subscription_on_session' });
    }

    await writeSnapshot(supabase, owner.userId, sub);

    // Also stamp supabase_user_id on Stripe side for future webhook traceability.
    await Promise.all([
      stripe.subscriptions
        .update(sub.id, {
          metadata: { ...(sub.metadata || {}), supabase_user_id: owner.userId },
        })
        .catch(() => {}),
      (async () => {
        const customerId =
          typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
        try {
          await stripe.customers.update(customerId, {
            metadata: { supabase_user_id: owner.userId },
          });
        } catch {
          /* non-fatal */
        }
      })(),
    ]);

    return res.json({ isPaid: true });
  } catch (err: any) {
    console.error('verify-session error:', err?.message);
    return res.status(500).json({ error: 'Failed to verify session' });
  }
}

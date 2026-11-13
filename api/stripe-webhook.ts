// Stripe webhook: checkout.session.completed + customer.subscription.updated/.deleted.
// Helpers inlined — see api/check-subscription.ts for context.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Stripe signature verification requires the raw request body.
export const config = {
  api: {
    bodyParser: false,
  },
};

async function readRawBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

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

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Find a Supabase user id by email. Paged, but subscription events are
// infrequent. Used as a fallback when a purchase carries no supabase_user_id
// (e.g. Stripe Payment Links, which don't set client_reference_id).
async function findUserIdByEmail(email: string | null | undefined): Promise<string | null> {
  if (!email) return null;
  const supabase = getSupabase();
  const target = email.toLowerCase();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return null;
    const u = data.users.find((x) => (x.email || '').toLowerCase() === target);
    if (u) return u.id;
    if (data.users.length < 1000) break;
  }
  return null;
}

// Layer C: record a paid checkout that couldn't be linked to any account.
// Best-effort — if the billing_orphans table doesn't exist yet (migration not
// run), we still emit the loud log line below, so nothing is silently lost.
async function recordOrphan(
  session: Stripe.Checkout.Session,
  email: string | null,
  reason: string,
): Promise<void> {
  try {
    const supabase = getSupabase();
    const subId =
      typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription?.id ?? null;
    const custId =
      typeof session.customer === 'string'
        ? session.customer
        : session.customer?.id ?? null;
    const { error } = await supabase.from('billing_orphans').upsert(
      {
        stripe_session_id: session.id,
        stripe_subscription_id: subId,
        stripe_customer_id: custId,
        email,
        status: 'unresolved',
        reason,
      },
      { onConflict: 'stripe_session_id' },
    );
    if (error) {
      console.error(
        `[orphan] could not persist ${session.id}: ${error.message} — run pipeline/billing_orphans.sql`,
      );
    }
  } catch (e: any) {
    console.error(`[orphan] recordOrphan threw for ${session.id}: ${e?.message}`);
  }
}

// Resolve the Supabase user id for a subscription event: prefer the stamped
// metadata, fall back to matching the Stripe customer's email.
async function resolveUserIdForSub(stripe: Stripe, sub: Stripe.Subscription): Promise<string | null> {
  if (sub.metadata?.supabase_user_id) return sub.metadata.supabase_user_id;
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  if (!customerId) return null;
  try {
    const c = await stripe.customers.retrieve(customerId);
    return await findUserIdByEmail((c as any)?.email);
  } catch {
    return null;
  }
}

async function writeSnapshot(userId: string, sub: Stripe.Subscription) {
  const supabase = getSupabase();
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data.user) throw new Error(`User ${userId} not found`);
  const prev = (data.user.app_metadata as Record<string, any>) || {};
  const { error: updErr } = await supabase.auth.admin.updateUserById(userId, {
    app_metadata: { ...prev, subscription: snapshot(sub) },
  });
  if (updErr) throw new Error(`Failed to update user: ${updErr.message}`);
}

async function upsertForUser(
  stripe: Stripe,
  userId: string,
  subscriptionId: string,
) {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  await writeSnapshot(userId, sub);

  // Stamp supabase_user_id on Stripe customer + subscription for traceability.
  await Promise.all([
    stripe.subscriptions
      .update(sub.id, {
        metadata: { ...(sub.metadata || {}), supabase_user_id: userId },
      })
      .catch(() => {}),
    (async () => {
      const customerId =
        typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
      try {
        await stripe.customers.update(customerId, {
          metadata: { supabase_user_id: userId },
        });
      } catch {
        /* non-fatal */
      }
    })(),
  ]);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const signature = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!signature || !webhookSecret) {
    return res.status(400).json({ error: 'Missing signature or webhook secret' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const rawBody = await readRawBody(req);

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err: any) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Signature verification failed: ${err.message}` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        let userId =
          session.client_reference_id ||
          (session.metadata && session.metadata.supabase_user_id) ||
          null;
        // Payment Links carry no client_reference_id, but Stripe captures the
        // buyer's email — match it to a Supabase account so access is granted.
        if (!userId) {
          const email =
            session.customer_details?.email || (session as any).customer_email || null;
          userId = await findUserIdByEmail(email);
          if (userId) {
            console.log(`checkout.session.completed ${session.id}: linked to ${userId} via email ${email}`);
          }
        }
        const subscriptionId =
          typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription?.id;
        if (!userId) {
          const email2 =
            session.customer_details?.email || (session as any).customer_email || null;
          // Layer C: loud + durable. A paying customer we can't link should be
          // impossible to miss — not one console.error buried in the stream.
          console.error(
            `🚨 BILLING ORPHAN: paid checkout ${session.id} (${email2 ?? 'no email'}) matched no Supabase account — access NOT granted, recorded in billing_orphans`,
          );
          await recordOrphan(
            session,
            email2,
            'paid checkout with no client_reference_id and buyer email matched no account',
          );
          break;
        }
        if (!subscriptionId) break;
        await upsertForUser(stripe, userId, subscriptionId);
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        // The event carries the subscription as it was WHEN THE EVENT WAS MADE,
        // and Stripe does not deliver in order. A delayed `updated` (active)
        // arriving after `deleted` (canceled) would write 'active' back and
        // leave a cancelled customer on Pro until something else touched the
        // record. Ask Stripe what is true now, as checkout.session.completed
        // and the dev server already do; a deleted subscription still
        // retrieves, with status 'canceled'. Fall back to the payload only if
        // the read fails, so an event is never dropped.
        const fromEvent = event.data.object as Stripe.Subscription;
        const sub = await stripe.subscriptions
          .retrieve(fromEvent.id)
          .catch(() => fromEvent);
        const userId = await resolveUserIdForSub(stripe, sub);
        if (!userId) {
          console.warn(`${event.type} for ${sub.id}: no supabase_user_id and customer email matched no account — ignoring`);
          break;
        }
        await writeSnapshot(userId, sub);
        break;
      }

      default:
        break;
    }

    return res.json({ received: true });
  } catch (err: any) {
    console.error(`Error handling ${event.type}:`, err?.message);
    return res.status(500).json({ error: err?.message });
  }
}

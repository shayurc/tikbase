// Delete the caller's own account.
//
// Settings has shown a red "Delete Account" button since launch that was not
// wired to anything. This is the endpoint it should have had.
//
// Deliberately narrow:
//   - the account is the one the bearer token belongs to, never one named in
//     the request;
//   - it refuses while a subscription is live. Deleting the login would leave
//     Stripe charging a card for an account nobody can sign in to, and this
//     endpoint does not cancel on the customer's behalf — they do that in the
//     billing portal, where they can see what they are cancelling;
//   - the request must carry confirm:"DELETE", so a stray POST cannot do it.
//
// What is removed is the Supabase auth user, which is everything TikBase holds
// about a person (saved items live in their browser, not here).

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { ACTIVE_STATUSES } from './_lib/resolve-tier.js';
import { appleRecordActive } from './_lib/apple-subscription.js';

export const CONFIRM_WORD = 'DELETE';

export type DeleteDecision =
  | { ok: true }
  | { ok: false; status: 400 | 409; error: string; message: string };

/** Whether this account may be deleted right now. Pure, so it is tested. */
export function deletionDecision(input: {
  confirm: unknown;
  subscriptionStatus: string | null | undefined;
  /** A live subscription bought in the iPhone app. Optional for old callers. */
  appleActive?: boolean;
}): DeleteDecision {
  if (input.confirm !== CONFIRM_WORD) {
    return {
      ok: false,
      status: 400,
      error: 'confirmation_required',
      message: `Type ${CONFIRM_WORD} to confirm.`,
    };
  }
  if (input.subscriptionStatus && ACTIVE_STATUSES.has(input.subscriptionStatus)) {
    return {
      ok: false,
      status: 409,
      error: 'subscription_active',
      message:
        'You have an active subscription. Cancel it in Billing first, then delete your account.',
    };
  }
  // Same reasoning for Apple, with one difference that changes the wording:
  // we cannot cancel an Apple subscription for anyone, and neither can our
  // Billing page. Only the customer can, in their Apple Account settings.
  if (input.appleActive) {
    return {
      ok: false,
      status: 409,
      error: 'subscription_active',
      message:
        'You have an active subscription through the iPhone app. Cancel it in your Apple Account settings (Settings, your name, Subscriptions), then delete your account once it has ended.',
    };
  }
  return { ok: true };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');

  try {
    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return res.status(500).json({ error: 'Supabase env vars missing' });
    const supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const raw = req.headers.authorization;
    const header = Array.isArray(raw) ? raw[0] : raw || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authData.user) return res.status(401).json({ error: 'Unauthorized' });
    const userId = authData.user.id;

    // Read the plan from the stored record, not from the token's claims.
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error || !data.user) {
      // Could not read the plan: do not delete on a guess.
      res.setHeader('Retry-After', '30');
      return res.status(503).json({
        error: 'plan_check_failed',
        message: 'We could not check your plan, so nothing was deleted. Please try again.',
      });
    }

    const decision = deletionDecision({
      confirm: (req.body ?? {}).confirm,
      subscriptionStatus: (data.user.app_metadata as any)?.subscription?.status,
      appleActive: appleRecordActive((data.user.app_metadata as any)?.apple_subscription),
    });
    if (!decision.ok) {
      return res.status(decision.status).json({ error: decision.error, message: decision.message });
    }

    const { error: delError } = await supabase.auth.admin.deleteUser(userId);
    if (delError) {
      console.error(`delete-account: deleteUser failed for ${userId}: ${delError.message}`);
      return res.status(500).json({
        error: 'delete_failed',
        message: 'Your account could not be deleted. Nothing was changed.',
      });
    }
    console.log(`delete-account: deleted user ${userId} at their own request`);
    return res.json({ deleted: true });
  } catch (err: any) {
    console.error('delete-account error:', err?.message);
    return res.status(500).json({
      error: 'delete_failed',
      message: 'Your account could not be deleted. Nothing was changed.',
    });
  }
}

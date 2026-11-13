// Claiming an Apple subscription that names no account.
//
// See migrations/manual/2026-11-13-apple-subscription-links.sql for why this
// exists. In short: an offer code or promoted purchase has no appAccountToken,
// so the first TikBase account to present the receipt claims it and no other
// account can.
//
// Every failure here means "do not grant": a claim we could not record or read
// back is reported as unavailable, never assumed to be ours.

import type { SupabaseClient } from '@supabase/supabase-js';

const TABLE = 'apple_subscription_links';

export type ClaimResult =
  | { ok: true }
  | { ok: false; reason: 'different_account' | 'unavailable' };

async function holderOf(
  supabase: SupabaseClient,
  originalTransactionId: string,
): Promise<{ userId: string | null } | 'unavailable'> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('user_id')
    .eq('original_transaction_id', originalTransactionId)
    .maybeSingle();
  if (error) return 'unavailable';
  return { userId: (data as any)?.user_id ?? null };
}

/** The account a tokenless subscription is linked to, null if none, or 'unavailable'. */
export async function linkedUserId(
  supabase: SupabaseClient,
  originalTransactionId: string,
): Promise<string | null | 'unavailable'> {
  const held = await holderOf(supabase, originalTransactionId);
  return held === 'unavailable' ? 'unavailable' : held.userId;
}

export async function claimSubscription(
  supabase: SupabaseClient,
  originalTransactionId: string,
  userId: string,
): Promise<ClaimResult> {
  // Insert-if-absent. The primary key decides a race; whoever lost reads the
  // winner back below.
  const { error: insErr } = await supabase
    .from(TABLE)
    .upsert(
      { original_transaction_id: originalTransactionId, user_id: userId },
      { onConflict: 'original_transaction_id', ignoreDuplicates: true },
    );
  if (insErr) return { ok: false, reason: 'unavailable' };

  const held = await holderOf(supabase, originalTransactionId);
  if (held === 'unavailable' || !held.userId) return { ok: false, reason: 'unavailable' };
  if (held.userId === userId) return { ok: true };

  // Held by someone else. If that account has since been deleted, the
  // subscription would be stranded: still billing, usable by nobody. Let it
  // move, but only when we can positively see the holder is gone.
  const { data: holder, error: holderErr } = await supabase.auth.admin.getUserById(held.userId);
  const gone =
    (holderErr && Number((holderErr as any).status) === 404) || (!holderErr && !holder?.user);
  if (!gone) {
    return { ok: false, reason: holderErr ? 'unavailable' : 'different_account' };
  }
  // Conditional on the old holder, so two accounts racing for a stranded
  // subscription cannot both take it.
  const { error: updErr } = await supabase
    .from(TABLE)
    .update({ user_id: userId })
    .eq('original_transaction_id', originalTransactionId)
    .eq('user_id', held.userId);
  if (updErr) return { ok: false, reason: 'unavailable' };
  const after = await holderOf(supabase, originalTransactionId);
  if (after === 'unavailable') return { ok: false, reason: 'unavailable' };
  return after.userId === userId ? { ok: true } : { ok: false, reason: 'different_account' };
}

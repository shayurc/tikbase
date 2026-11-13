// Apple calls this when something happens to a subscription without the app
// being open: it renewed, the card failed, it was cancelled and ran out, or
// Apple refunded it. (App Store Server Notifications, version 2. The address
// of this endpoint is entered in App Store Connect.)
//
//   POST /api/apple-notifications   { "signedPayload": "<JWS>" }
//
// There is no shared secret and none is needed: the body is signed by Apple
// and verified against Apple's root certificate, as is the transaction inside
// it. Anything unsigned or mis-signed gets a 400 and changes nothing.
//
// The account is found from the id the app stamped into the purchase
// (appAccountToken), which Apple echoes back inside its signature.
//
// Answers 200 once a genuine notice has been handled OR deliberately ignored,
// because Apple retries anything else for days. Answers 5xx only when the
// database could not be reached, so that Apple does retry.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { verifyAppleJws, AppleJwsError } from './_lib/apple-jws.js';
import {
  appleConfig,
  checkTransaction,
  recordFromTransaction,
  newerRecord,
  type AppleTransaction,
} from './_lib/apple-subscription.js';

interface NotificationPayload {
  notificationType?: string;
  subtype?: string;
  signedDate?: number;
  data?: {
    signedTransactionInfo?: string;
    signedRenewalInfo?: string;
  };
}

/** Notices that end access whatever the transaction's own dates say. */
export function forcedStatus(type: string | undefined): 'expired' | 'revoked' | undefined {
  if (type === 'REFUND' || type === 'REVOKE') return 'revoked';
  if (type === 'EXPIRED' || type === 'GRACE_PERIOD_EXPIRED') return 'expired';
  return undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');

  let note: NotificationPayload;
  let tx: AppleTransaction;
  let gracePeriodExpiresDate: number | undefined;
  try {
    note = verifyAppleJws<NotificationPayload>((req.body ?? {}).signedPayload);
    if (!note.data?.signedTransactionInfo) {
      // Genuine, but not about a transaction (a TEST ping, for example).
      console.log(`apple-notifications: ${note.notificationType} carries no transaction, ignored`);
      return res.status(200).json({ ok: true });
    }
    tx = verifyAppleJws<AppleTransaction>(note.data.signedTransactionInfo);
    if (note.data.signedRenewalInfo) {
      const renewal = verifyAppleJws<{ gracePeriodExpiresDate?: number }>(note.data.signedRenewalInfo);
      gracePeriodExpiresDate = renewal.gracePeriodExpiresDate;
    }
  } catch (err) {
    if (!(err instanceof AppleJwsError)) {
      console.error('apple-notifications error:', (err as any)?.message);
      return res.status(500).json({ error: 'failed' });
    }
    console.warn(`apple-notifications: rejected: ${err.message}`);
    return res.status(400).json({ error: 'invalid_signature' });
  }

  const userId = tx.appAccountToken || '';
  if (!UUID.test(userId)) {
    console.warn(`apple-notifications: ${note.notificationType} tx ${tx.transactionId} has no account id, ignored`);
    return res.status(200).json({ ok: true });
  }
  const check = checkTransaction(tx, userId, appleConfig());
  if (!check.ok) {
    console.warn(`apple-notifications: ${note.notificationType} tx ${tx.transactionId} ignored: ${check.error}`);
    return res.status(200).json({ ok: true });
  }

  try {
    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return res.status(500).json({ error: 'Supabase env vars missing' });
    const supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error && Number((error as any).status) === 404) {
      // The account was deleted. Nothing to update; do not make Apple retry.
      console.warn(`apple-notifications: ${note.notificationType} for deleted account ${userId}, ignored`);
      return res.status(200).json({ ok: true });
    }
    if (error || !data.user) return res.status(503).json({ error: 'service_unavailable' });
    const prev = (data.user.app_metadata as Record<string, any>) || {};

    // Order by when Apple signed the NOTICE, which is later than the
    // transaction inside it: a refund notice carries the original purchase.
    const incoming = recordFromTransaction(
      { ...tx, signedDate: note.signedDate ?? tx.signedDate },
      Date.now(),
      { gracePeriodExpiresDate, forceStatus: forcedStatus(note.notificationType) },
    );
    const record = newerRecord(prev.apple_subscription, incoming);
    const { error: updErr } = await supabase.auth.admin.updateUserById(userId, {
      app_metadata: { ...prev, apple_subscription: record },
    });
    if (updErr) {
      console.error(`apple-notifications: could not save for ${userId}: ${updErr.message}`);
      return res.status(503).json({ error: 'service_unavailable' });
    }
    console.log(
      `apple-notifications: ${note.notificationType}${note.subtype ? '/' + note.subtype : ''} -> ${userId} ${record.status} until ${record.expires_at}`,
    );
    return res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error('apple-notifications error:', err?.message);
    return res.status(503).json({ error: 'service_unavailable' });
  }
}

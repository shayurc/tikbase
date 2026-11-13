// The iPhone app calls this after an in-app purchase (and again on launch or
// "Restore Purchases" if it finds itself signed in but not Pro).
//
//   POST /api/apple-subscription
//   Authorization: Bearer <Supabase access token>
//   { "transaction": "<the signed transaction StoreKit handed the app>" }
//   -> { "isPaid": boolean }
//
// Nothing the app says is believed. The transaction is a JWS signed by Apple;
// it is verified against Apple's root certificate here, and then it has to be
// for this app, for a Pro product, and stamped with the caller's own account
// id (see checkTransaction). Only then is the account marked Pro, in
// app_metadata.apple_subscription, where the tier gate reads it.
//
// This endpoint cannot charge anyone and cannot grant more than the receipt
// proves, so a failure is always safe to retry.

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
import { claimSubscription } from './_lib/apple-links.js';
import { hasPaidAccess } from './_lib/resolve-tier.js';
import { isUpstreamOutage, unavailable } from './_lib/upstream.js';

function serveUnavailable(res: VercelResponse) {
  const u = unavailable();
  res.setHeader('Retry-After', u.retryAfter);
  return res.status(u.status).json(u.body);
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
    if (authError && isUpstreamOutage(authError)) return serveUnavailable(res);
    if (authError || !authData.user) return res.status(401).json({ error: 'Unauthorized' });
    const userId = authData.user.id;

    let tx: AppleTransaction;
    try {
      tx = verifyAppleJws<AppleTransaction>((req.body ?? {}).transaction);
    } catch (err) {
      if (!(err instanceof AppleJwsError)) throw err;
      console.warn(`apple-subscription: rejected receipt for ${userId}: ${err.message}`);
      return res.status(400).json({
        error: 'invalid_receipt',
        message: 'We could not confirm that purchase with Apple.',
      });
    }

    const check = checkTransaction(tx, userId, appleConfig());
    if (!check.ok) {
      console.warn(`apple-subscription: ${check.error} for ${userId} (tx ${tx.transactionId})`);
      return res.status(check.status).json({ error: check.error, message: check.message });
    }

    if (check.needsLink) {
      const claim = await claimSubscription(supabase, String(tx.originalTransactionId), userId);
      if (!claim.ok && claim.reason === 'different_account') {
        console.warn(`apple-subscription: tokenless tx ${tx.originalTransactionId} already held, refused for ${userId}`);
        return res.status(409).json({
          error: 'different_account',
          message:
            'This Apple subscription is already attached to a different TikBase account. Sign in to that account.',
        });
      }
      // Could not record or read the claim (including the table not existing
      // yet): do not grant on a guess. The app retries on its own.
      if (!claim.ok) return serveUnavailable(res);
    }

    // Read the stored record, not the token's claims: the claims are as old
    // as the token.
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error && isUpstreamOutage(error)) return serveUnavailable(res);
    if (error || !data.user) return serveUnavailable(res);
    const prev = (data.user.app_metadata as Record<string, any>) || {};

    const record = newerRecord(prev.apple_subscription, recordFromTransaction(tx, Date.now()));
    const next = { ...prev, apple_subscription: record };
    const { error: updErr } = await supabase.auth.admin.updateUserById(userId, { app_metadata: next });
    if (updErr) {
      console.error(`apple-subscription: could not save for ${userId}: ${updErr.message}`);
      return serveUnavailable(res);
    }
    console.log(
      `apple-subscription: ${userId} ${record.status} until ${record.expires_at} (${record.environment}, tx ${record.transaction_id})`,
    );
    return res.json({ isPaid: hasPaidAccess(next) });
  } catch (err: any) {
    console.error('apple-subscription error:', err?.message);
    if (isUpstreamOutage(err)) return serveUnavailable(res);
    return res.status(500).json({ error: 'activation_failed', message: 'Could not activate Pro. Please try again.' });
  }
}

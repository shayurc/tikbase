// What an Apple in-app subscription means for a TikBase account.
//
// Stripe subscriptions live in app_metadata.subscription. Apple ones live
// beside it, in app_metadata.apple_subscription, and never in the same slot:
// the Stripe webhook, verify-session and the check-subscription self-heal all
// overwrite `subscription` wholesale, so a late Stripe event for a cancelled
// web plan would otherwise erase a live Apple one. An account is Pro if either
// record says so (hasPaidAccess in resolve-tier.ts).
//
// Pure functions only, so the rules are tested without Apple or Supabase.

export const DEFAULT_BUNDLE_ID = 'io.tikbase.app';
export const DEFAULT_PRODUCT_IDS = ['io.tikbase.app.pro.monthly'];

/**
 * How long past its paid-through date an Apple record still counts.
 *
 * Renewals and expiries arrive as notices from Apple, and a notice can be
 * late or lost. Without an end date a lost "expired" notice would be Pro for
 * ever; with a hard end date a late "renewed" notice would paywall a paying
 * customer at the stroke of midnight. Three days of slack covers Apple's
 * retry schedule, and the app re-sends its current receipt whenever it finds
 * itself signed in but not Pro, which repairs the other direction.
 */
export const APPLE_EXPIRY_SLACK_MS = 3 * 86_400_000;

export interface AppleSubscriptionRecord {
  status: 'active' | 'expired' | 'revoked';
  product_id: string;
  original_transaction_id: string;
  transaction_id: string;
  /** Paid through, ISO. Includes Apple's billing grace period when in one. */
  expires_at: string | null;
  environment: string;
  /** When Apple signed the receipt this record came from, ms. Orders updates. */
  signed_at: number;
  updated_at: string;
}

/** The fields read from Apple's signed transaction (JWSTransactionDecodedPayload). */
export interface AppleTransaction {
  bundleId?: string;
  productId?: string;
  type?: string;
  environment?: string;
  appAccountToken?: string;
  originalTransactionId?: string;
  transactionId?: string;
  expiresDate?: number;
  revocationDate?: number;
  signedDate?: number;
}

export interface AppleConfig {
  bundleId: string;
  productIds: string[];
  allowSandbox: boolean;
}

export function appleConfig(env: Record<string, string | undefined> = process.env): AppleConfig {
  const ids = (env.APPLE_PRO_PRODUCT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    bundleId: env.APPLE_BUNDLE_ID || DEFAULT_BUNDLE_ID,
    productIds: ids.length ? ids : DEFAULT_PRODUCT_IDS,
    // On unless switched off. Apple's reviewers buy in the sandbox against the
    // production server, so refusing sandbox receipts fails review. A sandbox
    // subscription lasts about an hour and needs a tester account on our own
    // developer team, so the exposure is small. Set APPLE_ALLOW_SANDBOX=0 to
    // close it.
    allowSandbox: env.APPLE_ALLOW_SANDBOX !== '0',
  };
}

export type TransactionCheck =
  | { ok: true }
  | { ok: false; status: 400 | 409; error: string; message: string };

/** Is this genuine Apple receipt one that should count for THIS account? */
export function checkTransaction(
  tx: AppleTransaction,
  userId: string,
  cfg: AppleConfig,
): TransactionCheck {
  const wrongApp = {
    ok: false as const,
    status: 400 as const,
    error: 'wrong_product',
    message: 'That purchase is not a TikBase Pro subscription.',
  };
  if (tx.bundleId !== cfg.bundleId) return wrongApp;
  if (!tx.productId || !cfg.productIds.includes(tx.productId)) return wrongApp;
  if (!tx.originalTransactionId || !tx.transactionId) return wrongApp;
  if (tx.environment !== 'Production' && !(cfg.allowSandbox && tx.environment === 'Sandbox')) {
    return {
      ok: false,
      status: 400,
      error: 'wrong_environment',
      message: 'That purchase was made in a test environment and cannot be used here.',
    };
  }
  // The app stamps the buyer's account id into the purchase, and Apple signs
  // it. A receipt can therefore only ever switch Pro on for the account that
  // bought it: copying someone else's receipt, or restoring one Apple
  // subscription onto a second TikBase account, is refused here.
  if (!tx.appAccountToken || tx.appAccountToken.toLowerCase() !== userId.toLowerCase()) {
    return {
      ok: false,
      status: 409,
      error: 'different_account',
      message:
        'This Apple subscription belongs to a different TikBase account. Sign in to the account you bought it with.',
    };
  }
  return { ok: true };
}

/** The record a receipt describes, as of `now`. */
export function recordFromTransaction(
  tx: AppleTransaction,
  now: number,
  opts: { gracePeriodExpiresDate?: number; forceStatus?: 'expired' | 'revoked' } = {},
): AppleSubscriptionRecord {
  const paidThrough = Math.max(tx.expiresDate ?? 0, opts.gracePeriodExpiresDate ?? 0) || null;
  let status: AppleSubscriptionRecord['status'];
  if (opts.forceStatus) status = opts.forceStatus;
  else if (tx.revocationDate) status = 'revoked';
  else if (paidThrough && paidThrough > now) status = 'active';
  else status = 'expired';
  return {
    status,
    product_id: String(tx.productId),
    original_transaction_id: String(tx.originalTransactionId),
    transaction_id: String(tx.transactionId),
    expires_at: paidThrough ? new Date(paidThrough).toISOString() : null,
    environment: String(tx.environment),
    signed_at: tx.signedDate ?? now,
    updated_at: new Date(now).toISOString(),
  };
}

/**
 * Which record to keep. Apple does not deliver in order, and the app replays
 * old receipts, so an update only wins if Apple signed it later than what is
 * stored. Without this a replayed "active" receipt would undo a refund.
 */
export function newerRecord(
  stored: AppleSubscriptionRecord | null | undefined,
  incoming: AppleSubscriptionRecord,
): AppleSubscriptionRecord {
  if (!stored || typeof stored.signed_at !== 'number') return incoming;
  return incoming.signed_at >= stored.signed_at ? incoming : stored;
}

/** Does this stored Apple record grant Pro right now? */
export function appleRecordActive(record: unknown, now: number = Date.now()): boolean {
  const r = record as AppleSubscriptionRecord | null | undefined;
  if (!r || r.status !== 'active' || !r.expires_at) return false;
  const end = Date.parse(r.expires_at);
  return Number.isFinite(end) && end + APPLE_EXPIRY_SLACK_MS > now;
}

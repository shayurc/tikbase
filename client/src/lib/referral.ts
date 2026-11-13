/**
 * Referral attribution, vendor-neutral.
 *
 * An affiliate link lands on `/?via=jane` (Rewardful's default) or `?ref=jane`
 * (most of the others). The click and the signup are minutes and several page
 * loads apart, and the hash router rewrites the URL on the way, so the code has
 * to be captured the moment it arrives and carried in storage until there is a
 * user to attach it to.
 *
 * Deliberately not tied to a vendor: nothing here calls Rewardful, Tolt or
 * PartnerStack. It captures the code, survives the journey, and writes it to
 * `user_metadata.referral` at signup, where any of them can read it. Picking
 * the vendor is a dashboard decision — see docs/AFFILIATE-SETUP.md.
 */

const KEY = 'tikbase.referral';
/** Long enough to cover "clicked at lunch, signed up that evening". */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Every param an affiliate tool might land on. First one wins. */
const PARAMS = ['via', 'ref', 'referral', 'aff', 'fpr'];

export interface Referral {
  code: string;
  /** Which query parameter it arrived on — vendors differ, and it matters. */
  param: string;
  landedAt: string;
  /** Where the click came from, when the browser tells us. */
  landingPage: string;
  referrer: string | null;
}

/** A code is an identifier, not free text: keep it boring so it cannot be a payload. */
function clean(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim().slice(0, 64);
  return /^[A-Za-z0-9_.-]+$/.test(t) ? t : null;
}

/**
 * Read the code off the current URL and store it. Safe to call on every load —
 * a later visit without a code does NOT clear an earlier attribution, because
 * the second page view of the same session would otherwise erase it.
 */
export function captureReferral(): Referral | null {
  try {
    // The app is hash-routed, so a code can be in either half of the URL.
    const search = new URLSearchParams(window.location.search);
    const hashQ = window.location.hash.includes('?')
      ? new URLSearchParams(window.location.hash.slice(window.location.hash.indexOf('?') + 1))
      : new URLSearchParams();

    for (const param of PARAMS) {
      const code = clean(search.get(param) ?? hashQ.get(param));
      if (!code) continue;
      const rec: Referral = {
        code,
        param,
        landedAt: new Date().toISOString(),
        landingPage: window.location.pathname + window.location.hash,
        referrer: document.referrer || null,
      };
      localStorage.setItem(KEY, JSON.stringify(rec));
      return rec;
    }
    return getReferral();
  } catch {
    // Storage blocked (private mode, sandboxed iframe). Attribution is worth
    // less than the page rendering.
    return null;
  }
}

/** The stored code, or null once it has aged out. */
export function getReferral(): Referral | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as Referral;
    if (!rec?.code) return null;
    if (Date.now() - Date.parse(rec.landedAt) > TTL_MS) {
      localStorage.removeItem(KEY);
      return null;
    }
    return rec;
  } catch {
    return null;
  }
}

/** Called once the signup has actually written it to the user. */
export function clearReferral(): void {
  try { localStorage.removeItem(KEY); } catch { /* nothing to clean up */ }
}

/** How long after an account is created a stored code still counts as its source. */
export const ATTRIBUTION_WINDOW_MS = 15 * 60 * 1000;

/**
 * Should the stored code be written to this account now?
 *
 * Email sign-up writes the code as part of the sign-up call. A Google sign-up
 * never passes through that call, so the code rode the redirect back, was
 * stored again, and then nothing attached it to anyone: every affiliate-driven
 * Google sign-up was unattributed.
 *
 * It is attached at first sign-in instead — but only to an account that was
 * JUST created. Without that bound, an existing customer who later clicked an
 * affiliate link and signed in would be credited to that affiliate.
 */
export function shouldAttachReferral(input: {
  hasStoredCode: boolean;
  alreadyAttributed: boolean;
  accountCreatedAt: string | null | undefined;
  now?: number;
}): boolean {
  if (!input.hasStoredCode || input.alreadyAttributed) return false;
  const created = Date.parse(input.accountCreatedAt ?? '');
  if (!Number.isFinite(created)) return false;
  const age = (input.now ?? Date.now()) - created;
  return age >= 0 && age <= ATTRIBUTION_WINDOW_MS;
}

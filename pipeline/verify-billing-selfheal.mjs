// Verification harness for the billing self-heal (Layers B + C).
// Run: ORPHAN_EMAIL=<buyer's address> node --env-file=.env pipeline/verify-billing-selfheal.mjs
// REAL against live Stripe/Supabase for detection; SIMULATED (in-memory) for
// the account-write + idempotency paths so it mutates no real user.
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
// Whose unlinked purchase Layer B should find. A real customer's address used
// to be hard-coded further down, in a public repository; it is read from the
// environment now and is never committed. Checked first, so the script cannot
// write its Layer C test row and then stop halfway.
const ORPHAN_EMAIL = process.env.ORPHAN_EMAIL;
if (!ORPHAN_EMAIL) {
  console.error(
    "Set ORPHAN_EMAIL to the address of a buyer whose purchase is not linked to an account.",
  );
  process.exit(1);
}
const ACTIVE = new Set(["active", "trialing", "past_due"]);
const isPaid = (s) => !!s && ACTIVE.has(s);
function snapshot(sub) {
  const item = sub.items.data[0];
  const cpe = item?.current_period_end ?? sub.current_period_end ?? null;
  return {
    status: sub.status,
    stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    stripe_subscription_id: sub.id,
    price_id: item?.price?.id ?? null,
    current_period_end: cpe ? new Date(cpe * 1000).toISOString() : null,
    cancel_at_period_end: sub.cancel_at_period_end ?? false,
    updated_at: new Date().toISOString(),
  };
}
async function findUserIdByEmail(email) {
  if (!email) return null;
  const t = email.toLowerCase();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return null;
    const u = data.users.find((x) => (x.email || "").toLowerCase() === t);
    if (u) return u.id;
    if (data.users.length < 1000) break;
  }
  return null;
}

// ============ LAYER C: a Payment-Link-style orphan gets recorded ============
console.log("======== LAYER C: orphan recording ========");
const sess = {
  id: "cs_sim_" + Date.now(),
  client_reference_id: null, // <- Payment Link fingerprint
  metadata: {},
  customer_email: "selfheal_noaccount@example.test", // matches no account
  subscription: "sub_sim_orphan",
  customer: "cus_sim_orphan",
};
const resolved =
  sess.client_reference_id || sess.metadata?.supabase_user_id || (await findUserIdByEmail(sess.customer_email));
console.log(`resolve chain (client_ref -> metadata -> email) => ${resolved}`);
if (resolved) throw new Error("expected no account for the synthetic email");
console.log(`🚨 BILLING ORPHAN: paid checkout ${sess.id} (${sess.customer_email}) matched no account — access NOT granted`);
const { error: insErr } = await sb.from("billing_orphans").upsert(
  {
    stripe_session_id: sess.id,
    stripe_subscription_id: sess.subscription,
    stripe_customer_id: sess.customer,
    email: sess.customer_email,
    status: "unresolved",
    reason: "paid checkout with no client_reference_id and buyer email matched no account",
  },
  { onConflict: "stripe_session_id" },
);
if (insErr) {
  console.log(`[orphan] persist skipped: ${insErr.message}`);
  console.log("        -> run pipeline/billing_orphans.sql in the Supabase SQL editor, then re-run this to see the row.");
} else {
  const { data } = await sb.from("billing_orphans").select("*").eq("stripe_session_id", sess.id).single();
  console.log("[orphan] RECORDED:", JSON.stringify({ email: data.email, status: data.status, reason: data.reason }));
  await sb.from("billing_orphans").delete().eq("stripe_session_id", sess.id); // cleanup test row
  console.log("[orphan] (test row cleaned up)");
}

// ============ LAYER B: reconcile-at-login catches the real orphan ============
console.log("\n======== LAYER B: reconcile detection (REAL, live Stripe) ========");
const custs = await stripe.customers.list({ email: ORPHAN_EMAIL, limit: 10 });
let realSub = null;
for (const c of custs.data) {
  const subs = await stripe.subscriptions.list({ customer: c.id, status: "all", limit: 10 });
  const a = subs.data.find((s) => ACTIVE.has(s.status));
  if (a) { realSub = a; break; }
}
console.log(`login as ${ORPHAN_EMAIL} -> Stripe lookup finds: ${realSub?.id} (${realSub?.status})`);
console.log("snapshot that reconcile WOULD stamp on the account:");
console.log("  " + JSON.stringify(snapshot(realSub)));

// ---- Simulated account write + idempotency (no real user mutated) ----
console.log("\n======== LAYER B: link + idempotency (simulated account) ========");
// A faithful copy of the handler's guard/throttle decision + the link step.
function reconcileDecision(meta, now) {
  if (isPaid(meta.subscription?.status)) return "SKIP (already paid — no Stripe call)";
  const last = meta.reconcile_checked_at ? Date.parse(meta.reconcile_checked_at) : 0;
  if (now - last <= 60 * 60 * 1000) return "SKIP (throttled — checked <1h ago)";
  return "RUN reconcile";
}
let acct = { app_metadata: {} }; // brand-new free user, never checked
const now = Date.now();
console.log(`1) fresh free user            -> ${reconcileDecision(acct.app_metadata, now)}`);
// fires: link it (this is what reconcileFromStripe does on a real account)
acct.app_metadata = { ...acct.app_metadata, subscription: snapshot(realSub), reconcile_checked_at: new Date(now).toISOString() };
console.log(`   [reconcile] fired -> stamped subscription=${acct.app_metadata.subscription.status}; log line emitted`);
console.log(`2) same user, immediately after -> ${reconcileDecision(acct.app_metadata, now)}`);
console.log(`3) unpaid user checked 5m ago   -> ${reconcileDecision({ reconcile_checked_at: new Date(now - 5 * 60000).toISOString() }, now)}`);
console.log(`4) unpaid user checked 2h ago   -> ${reconcileDecision({ reconcile_checked_at: new Date(now - 2 * 3600000).toISOString() }, now)}`);
console.log("\nidempotent: once linked (case 2) it never re-hits Stripe; throttle (case 3) caps free-user lookups to 1/hour.");

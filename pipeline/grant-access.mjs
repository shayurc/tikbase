// Manual access grant for a paying customer whose payment didn't auto-link.
// Usage:
//   node --env-file=.env pipeline/grant-access.mjs <email> [--create]
//
// Resolves the Supabase account for <email>. If it exists, stamps that account
// with the customer's active Stripe subscription. If it does NOT exist, pass
// --create to make one (email pre-confirmed) and send a password-reset so the
// customer can log in. Idempotent: re-running just re-writes the same snapshot.
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const email = process.argv[2];
const doCreate = process.argv.includes("--create");
if (!email) { console.error("usage: node grant-access.mjs <email> [--create]"); process.exit(1); }

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

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

// 1. Find the customer's active subscription in Stripe
const custs = await stripe.customers.list({ email, limit: 10 });
let sub = null;
for (const c of custs.data) {
  const subs = await stripe.subscriptions.list({ customer: c.id, status: "all", limit: 10 });
  sub = subs.data.find((s) => ["active", "trialing", "past_due"].includes(s.status)) || sub;
}
if (!sub) { console.error(`No active Stripe subscription for ${email}`); process.exit(1); }
console.log(`Stripe sub ${sub.id} (${sub.status})`);

// 2. Find (or create) the Supabase account
async function findUser(target) {
  const t = target.toLowerCase();
  for (let page = 1; page <= 50; page++) {
    const { data } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
    const u = data.users.find((x) => (x.email || "").toLowerCase() === t);
    if (u) return u;
    if (data.users.length < 1000) break;
  }
  return null;
}
let user = await findUser(email);
if (!user) {
  if (!doCreate) {
    console.error(`No Supabase account for ${email}. Re-run with --create to make one, OR pass the customer's real signup email instead.`);
    process.exit(1);
  }
  const { data, error } = await sb.auth.admin.createUser({ email, email_confirm: true });
  if (error) { console.error("createUser failed:", error.message); process.exit(1); }
  user = data.user;
  console.log(`Created account ${user.id} for ${email}`);
  // generateLink only RETURNS a link; it sends nothing. This line used to call
  // it, discard the link, and log "Password-reset email queued" — so a customer
  // whose account was created here never received a way to sign in.
  // resetPasswordForEmail is the call that sends the email.
  const { error: mailErr } = await sb.auth.resetPasswordForEmail(email);
  if (mailErr) {
    console.error(`Password-reset email NOT sent (${mailErr.message}). Send the customer to "Forgot your password?" on the login page.`);
  } else {
    console.log("Password-reset email sent (customer sets their own password).");
  }
}

// 3. Stamp the subscription onto the account + backfill Stripe metadata
const prev = user.app_metadata || {};
const { error: updErr } = await sb.auth.admin.updateUserById(user.id, {
  app_metadata: { ...prev, subscription: snapshot(sub) },
});
if (updErr) { console.error("grant failed:", updErr.message); process.exit(1); }
await stripe.subscriptions.update(sub.id, { metadata: { ...(sub.metadata || {}), supabase_user_id: user.id } }).catch(() => {});
console.log(`✓ Granted ${sub.status} access to ${email} (account ${user.id})`);

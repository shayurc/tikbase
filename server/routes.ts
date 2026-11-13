import type { Express, Request, Response } from "express";
import { type Server } from "http";
import Stripe from "stripe";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import topProductsHandler from "../api/top-products";
import topVideosHandler from "../api/top-videos";
import topCreatorsHandler from "../api/top-creators";
import avatarHandler from "../api/avatar";
import thumbHandler from "../api/thumb";
import creatorSearchHandler from "../api/creator-search";
import creatorProfileHandler from "../api/creator-profile";
import productSearchHandler from "../api/product-search";
import brandSearchHandler from "../api/brand-search";
import brandProfileHandler from "../api/brand-profile";
import { isUpstreamOutage, unavailable } from "../api/_lib/upstream.js";
import productDetailHandler from "../api/product-detail";
import videoTranscriptHandler from "../api/video-transcript";
import deleteAccountHandler from "../api/delete-account";

// ---- Supabase admin client (service role, server-only) ----
let cachedAdmin: SupabaseClient | null = null;
function getSupabaseAdmin(): SupabaseClient {
  if (cachedAdmin) return cachedAdmin;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  cachedAdmin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedAdmin;
}

// Verify the caller's Supabase access token and return their user id, or null.
// Never trust a client-supplied user_id for per-user actions.
/** 'outage' is not the same answer as null: null means "not signed in". */
async function getAuthedUserId(req: Request): Promise<string | null | "outage"> {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return null;
  const { data, error } = await getSupabaseAdmin().auth.getUser(token);
  if (error && isUpstreamOutage(error)) return "outage";
  if (error || !data.user) return null;
  return data.user.id;
}

/** Mirrors api/check-subscription.ts — a 503 is a fact, isPaid:false is a claim. */
function serveUnavailable(res: Response) {
  const u = unavailable();
  res.setHeader("Retry-After", u.retryAfter);
  res.setHeader("Cache-Control", "no-store");
  return res.status(u.status).json(u.body);
}

const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);
const isPaidStatus = (s: string | null | undefined) =>
  !!s && ACTIVE_STATUSES.has(s);

interface StoredSubscription {
  status: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  price_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  updated_at: string;
}

function snapshot(sub: Stripe.Subscription): StoredSubscription {
  // current_period_end moved to the item level in recent Stripe API versions.
  const item = sub.items.data[0];
  const cpe =
    (item as any)?.current_period_end ??
    (sub as any).current_period_end ??
    null;
  return {
    status: sub.status,
    stripe_customer_id:
      typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    stripe_subscription_id: sub.id,
    price_id: item?.price?.id ?? null,
    current_period_end: cpe ? new Date(cpe * 1000).toISOString() : null,
    cancel_at_period_end: sub.cancel_at_period_end ?? false,
    updated_at: new Date().toISOString(),
  };
}

async function writeToUser(
  userId: string,
  sub: Stripe.Subscription,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: userData, error: getErr } =
    await supabase.auth.admin.getUserById(userId);
  if (getErr || !userData.user) {
    throw new Error(`User ${userId} not found: ${getErr?.message}`);
  }
  const prev = (userData.user.app_metadata as Record<string, any>) || {};
  const { error: updErr } = await supabase.auth.admin.updateUserById(userId, {
    app_metadata: { ...prev, subscription: snapshot(sub) },
  });
  if (updErr) {
    throw new Error(
      `Failed to update user ${userId} app_metadata: ${updErr.message}`,
    );
  }
}

async function upsertSubscriptionForUser(
  stripe: Stripe,
  userId: string,
  subscriptionId: string,
): Promise<void> {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  await writeToUser(userId, sub);

  await Promise.all([
    stripe.subscriptions
      .update(sub.id, {
        metadata: { ...(sub.metadata || {}), supabase_user_id: userId },
      })
      .catch(() => {}),
    (async () => {
      const customerId =
        typeof sub.customer === "string" ? sub.customer : sub.customer.id;
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

async function syncSubscriptionById(
  stripe: Stripe,
  subscriptionId: string,
): Promise<void> {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const userId = sub.metadata?.supabase_user_id;
  if (!userId) {
    throw new Error(
      `subscription ${sub.id} has no supabase_user_id metadata — cannot sync`,
    );
  }
  await writeToUser(userId, sub);
}

async function getStoredSubscription(
  userId: string,
): Promise<StoredSubscription | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data.user) return null;
  const meta = (data.user.app_metadata as Record<string, any>) || {};
  return (meta.subscription as StoredSubscription | undefined) ?? null;
}

// Find a Supabase user id by email (fallback when a purchase carries no
// supabase_user_id — e.g. a raw Payment Link).
async function findUserIdByEmail(
  email: string | null | undefined,
): Promise<string | null> {
  if (!email) return null;
  const supabase = getSupabaseAdmin();
  const target = email.toLowerCase();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (error) return null;
    const u = data.users.find((x) => (x.email || "").toLowerCase() === target);
    if (u) return u.id;
    if (data.users.length < 1000) break;
  }
  return null;
}

// Layer C: record a paid checkout we couldn't link (best-effort; loud log even
// if the billing_orphans table isn't there yet).
async function recordOrphan(
  session: Stripe.Checkout.Session,
  email: string | null,
  reason: string,
): Promise<void> {
  try {
    const supabase = getSupabaseAdmin();
    const subId =
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id ?? null;
    const custId =
      typeof session.customer === "string"
        ? session.customer
        : session.customer?.id ?? null;
    const { error } = await supabase.from("billing_orphans").upsert(
      {
        stripe_session_id: session.id,
        stripe_subscription_id: subId,
        stripe_customer_id: custId,
        email,
        status: "unresolved",
        reason,
      },
      { onConflict: "stripe_session_id" },
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

// Layer B: reconcile-at-login. Self-heal a paying customer whose purchase was
// never linked (Payment Link paid before signup / mismatched email). Idempotent
// and throttled (see caller). Logs when it fires.
const RECONCILE_THROTTLE_MS = 60 * 60 * 1000;
async function reconcileFromStripe(
  stripe: Stripe,
  user: { id: string; email?: string; app_metadata?: Record<string, any> },
): Promise<StoredSubscription | null> {
  const email = user.email;
  if (!email) return null;
  const supabase = getSupabaseAdmin();

  const custs = await stripe.customers.list({ email, limit: 10 });
  let sub: Stripe.Subscription | null = null;
  for (const c of custs.data) {
    const subs = await stripe.subscriptions.list({
      customer: c.id,
      status: "all",
      limit: 10,
    });
    const active = subs.data.find((s) => ACTIVE_STATUSES.has(s.status));
    if (active) {
      sub = active;
      break;
    }
  }
  if (!sub) return null;

  const snap = snapshot(sub);
  const prev = user.app_metadata || {};
  await supabase.auth.admin.updateUserById(user.id, {
    app_metadata: {
      ...prev,
      subscription: snap,
      reconcile_checked_at: new Date().toISOString(),
    },
  });
  await stripe.subscriptions
    .update(sub.id, {
      metadata: { ...(sub.metadata || {}), supabase_user_id: user.id },
    })
    .catch(() => {});
  await supabase
    .from("billing_orphans")
    .update({
      status: "resolved",
      resolved_user_id: user.id,
      resolved_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", sub.id)
    .then(undefined, () => {});
  console.log(
    `[reconcile] self-healed access for user ${user.id} via email ${email} → ${sub.id} (${sub.status})`,
  );
  return snap;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  // ---- Top videos ----
  // Reuse the exact Vercel serverless handler (api/top-videos.ts), same pattern
  // as top-products, so dev and prod share one implementation and can't drift.
  app.get("/api/top-videos", async (req, res) => {
    try {
      await topVideosHandler(req as any, res as any);
    } catch (err: any) {
      console.error("top-videos (proxy) error:", err?.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to fetch videos" });
      }
    }
  });

  // ---- Top products ----
  // Reuse the exact Vercel serverless handler (api/top-products.ts) so local
  // dev (Express) and production (Vercel) can never drift. VercelRequest /
  // VercelResponse are structurally compatible with Express req/res for this
  // handler's usage (req.query, res.status/json/setHeader).
  app.get("/api/top-products", async (req, res) => {
    try {
      await topProductsHandler(req as any, res as any);
    } catch (err: any) {
      console.error("top-products (proxy) error:", err?.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to fetch products" });
      }
    }
  });

  // ---- Creator avatar proxy ----
  app.get("/api/avatar", async (req, res) => {
    try {
      await avatarHandler(req as any, res as any);
    } catch (err: any) {
      console.error("avatar (proxy) error:", err?.message);
      if (!res.headersSent) res.status(302).setHeader("Location", "/favicon.ico");
    }
  });

  // ---- Top creators (affiliate leaderboard) ----
  // Same proxy pattern as top-products: dev (Express) and prod (Vercel) share
  // one implementation so tier gating and the 503 shape can never drift.
  app.get("/api/top-creators", async (req, res) => {
    try {
      await topCreatorsHandler(req as any, res as any);
    } catch (err: any) {
      console.error("top-creators (proxy) error:", err?.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to fetch creators" });
      }
    }
  });

  // ---- Video thumbnail proxy ----
  // Existed as a Vercel function but was never registered here, so every
  // /api/thumb in dev fell through to the Vite catch-all and returned
  // index.html — which is why thumbnails render broken locally and the
  // leaderboard's product images sit behind an onError hide. Same proxy
  // pattern as the others: one implementation, both runtimes.
  app.get("/api/thumb", async (req, res) => {
    try {
      await thumbHandler(req as any, res as any);
    } catch (err: any) {
      console.error("thumb (proxy) error:", err?.message);
      if (!res.headersSent) res.status(302).setHeader("Location", "/favicon.ico");
    }
  });

  // ---- Creator search (type-ahead) ----
  app.get("/api/creator-search", async (req, res) => {
    try {
      await creatorSearchHandler(req as any, res as any);
    } catch (err: any) {
      console.error("creator-search (proxy) error:", err?.message);
      if (!res.headersSent) res.status(500).json({ error: "Search failed" });
    }
  });

  // ---- Creator profile ----
  app.get("/api/creator-profile", async (req, res) => {
    try {
      await creatorProfileHandler(req as any, res as any);
    } catch (err: any) {
      console.error("creator-profile (proxy) error:", err?.message);
      if (!res.headersSent) res.status(500).json({ error: "Failed to load creator" });
    }
  });

  // ---- Brand search (type-ahead) ----
  app.get("/api/brand-search", async (req, res) => {
    try {
      await brandSearchHandler(req as any, res as any);
    } catch (err: any) {
      console.error("brand-search (proxy) error:", err?.message);
      if (!res.headersSent) res.status(500).json({ error: "Search failed" });
    }
  });

  // ---- Brand profile ----
  app.get("/api/brand-profile", async (req, res) => {
    try {
      await brandProfileHandler(req as any, res as any);
    } catch (err: any) {
      console.error("brand-profile (proxy) error:", err?.message);
      if (!res.headersSent) res.status(500).json({ error: "Failed to load brand" });
    }
  });

  // ---- Product search (type-ahead) ----
  app.get("/api/product-search", async (req, res) => {
    try {
      await productSearchHandler(req as any, res as any);
    } catch (err: any) {
      console.error("product-search (proxy) error:", err?.message);
      if (!res.headersSent) res.status(500).json({ error: "Search failed" });
    }
  });

  // ---- Product detail ----
  app.get("/api/product-detail", async (req, res) => {
    try {
      await productDetailHandler(req as any, res as any);
    } catch (err: any) {
      console.error("product-detail (proxy) error:", err?.message);
      if (!res.headersSent) res.status(500).json({ error: "Failed to load product" });
    }
  });

  // ---- Video transcript ("study the script") ----
  app.get("/api/video-transcript", async (req, res) => {
    try {
      await videoTranscriptHandler(req as any, res as any);
    } catch (err: any) {
      console.error("video-transcript (proxy) error:", err?.message);
      if (!res.headersSent) res.status(500).json({ error: "Failed to load transcript" });
    }
  });

  // ---- Delete account ----
  app.post("/api/delete-account", async (req, res) => {
    try {
      await deleteAccountHandler(req as any, res as any);
    } catch (err: any) {
      console.error("delete-account (proxy) error:", err?.message);
      if (!res.headersSent) res.status(500).json({ error: "delete_failed" });
    }
  });

  // ---- Stripe webhook: uses req.rawBody (captured by express.json verify in server/index.ts) ----
  app.post("/api/stripe-webhook", async (req: Request, res) => {
    const signature = req.headers["stripe-signature"] as string | undefined;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!signature || !webhookSecret) {
      return res
        .status(400)
        .json({ error: "Missing signature or webhook secret" });
    }
    const rawBody = (req as any).rawBody as Buffer | undefined;
    if (!rawBody) {
      return res.status(400).json({ error: "Missing raw body" });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err: any) {
      console.error(
        "Stripe webhook signature verification failed:",
        err.message,
      );
      return res.status(400).json({ error: err.message });
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          const email =
            session.customer_details?.email ||
            (session as any).customer_email ||
            null;
          let userId =
            session.client_reference_id ||
            session.metadata?.supabase_user_id ||
            (await findUserIdByEmail(email));
          const subscriptionId =
            typeof session.subscription === "string"
              ? session.subscription
              : session.subscription?.id;
          if (!userId) {
            // Layer C: loud + durable.
            console.error(
              `🚨 BILLING ORPHAN: paid checkout ${session.id} (${email ?? "no email"}) matched no Supabase account — access NOT granted, recorded in billing_orphans`,
            );
            await recordOrphan(
              session,
              email,
              "paid checkout with no client_reference_id and buyer email matched no account",
            );
            break;
          }
          if (!subscriptionId) break;
          await upsertSubscriptionForUser(stripe, userId, subscriptionId);
          break;
        }
        case "customer.subscription.updated":
        case "customer.subscription.deleted": {
          const sub = event.data.object as Stripe.Subscription;
          if (!sub.metadata?.supabase_user_id) break;
          await syncSubscriptionById(stripe, sub.id);
          break;
        }
      }
      return res.json({ received: true });
    } catch (err: any) {
      console.error(`Webhook handler error (${event.type}):`, err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ---- Create Stripe Checkout Session (replaces raw Payment Link URLs) ----
  app.post("/api/create-checkout-session", async (req, res) => {
    try {
      const { plan, email, promo_code } = req.body ?? {};
      const PRICE_IDS: Record<string, string> = {
        monthly: "price_1THHz2CmsZejQhLSRBkSjObx",
        annual: "price_1THHz3CmsZejQhLScuVuKg8o",
      };
      if (!plan || !PRICE_IDS[plan]) {
        return res.status(400).json({ error: "Invalid or missing plan" });
      }
      const user_id = await getAuthedUserId(req);
      if (!user_id) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
      const proto = (req.headers["x-forwarded-proto"] as string) || "http";
      const host = req.headers["x-forwarded-host"] || req.headers.host;
      const baseUrl = process.env.APP_URL || `${proto}://${host}`;

      // Resolve promo code (human-readable → Stripe promotion_code id)
      let promoArg: Partial<Stripe.Checkout.SessionCreateParams> = {
        allow_promotion_codes: true,
      };
      if (promo_code) {
        try {
          const list = await stripe.promotionCodes.list({
            code: promo_code,
            active: true,
            limit: 1,
          });
          if (list.data[0]) {
            promoArg = { discounts: [{ promotion_code: list.data[0].id }] };
          }
        } catch {
          /* fall through to allow_promotion_codes */
        }
      }

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],
        client_reference_id: user_id,
        metadata: { supabase_user_id: user_id },
        subscription_data: { metadata: { supabase_user_id: user_id } },
        ...(email ? { customer_email: email } : {}),
        success_url: `${baseUrl}/?session_id={CHECKOUT_SESSION_ID}#/subscription-success`,
        cancel_url: `${baseUrl}/#/dashboard/plans`,
        ...promoArg,
      });

      return res.json({ url: session.url });
    } catch (err: any) {
      console.error("create-checkout-session error:", err.message);
      return res.status(500).json({ error: "Failed to create checkout session" });
    }
  });

  // ---- Verify checkout session (instant confirmation on success page) ----
  app.post("/api/verify-session", async (req, res) => {
    try {
      const { session_id, user_id } = req.body ?? {};
      if (!session_id || !user_id) {
        return res
          .status(400)
          .json({ error: "session_id and user_id are required" });
      }
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
      const session = await stripe.checkout.sessions.retrieve(session_id);

      if (
        session.client_reference_id &&
        session.client_reference_id !== user_id
      ) {
        return res
          .status(403)
          .json({ error: "Session does not belong to this user" });
      }
      if (session.payment_status !== "paid" && session.status !== "complete") {
        return res.json({ isPaid: false, status: session.status });
      }
      const subscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id;
      if (!subscriptionId) {
        return res.json({
          isPaid: false,
          reason: "no_subscription_on_session",
        });
      }
      await upsertSubscriptionForUser(stripe, user_id, subscriptionId);
      return res.json({ isPaid: true });
    } catch (err: any) {
      console.error("verify-session error:", err.message);
      return res.status(500).json({ error: "Failed to verify session" });
    }
  });

  // ---- Check subscription by supabase user_id ----
  app.get("/api/check-subscription", async (req, res) => {
    try {
      const userId = await getAuthedUserId(req);
      if (userId === "outage") return serveUnavailable(res);
      if (!userId) return res.json({ isPaid: false });

      const supabase = getSupabaseAdmin();
      const { data, error } = await supabase.auth.admin.getUserById(userId);
      if (error && isUpstreamOutage(error)) return serveUnavailable(res);
      if (error || !data.user) return res.json({ isPaid: false });
      const meta = (data.user.app_metadata as Record<string, any>) || {};
      let sub: StoredSubscription | undefined = meta.subscription;

      // Layer B: throttled self-heal from Stripe if not already paid.
      if (!isPaidStatus(sub?.status) && process.env.STRIPE_SECRET_KEY) {
        const last = meta.reconcile_checked_at
          ? Date.parse(meta.reconcile_checked_at)
          : 0;
        if (Date.now() - last > RECONCILE_THROTTLE_MS) {
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
          const healed = await reconcileFromStripe(stripe, {
            id: userId,
            email: data.user.email,
            app_metadata: meta,
          });
          if (healed) {
            sub = healed;
          } else {
            await supabase.auth.admin
              .updateUserById(userId, {
                app_metadata: {
                  ...meta,
                  reconcile_checked_at: new Date().toISOString(),
                },
              })
              .catch(() => {});
          }
        }
      }

      const referral = (data.user.user_metadata as Record<string, any> | null)?.referral;
      return res.json({
        isPaid: isPaidStatus(sub?.status),
        ...(referral?.code
          ? {
              referral: {
                code: String(referral.code),
                param: referral.param ?? null,
                landedAt: referral.landedAt ?? null,
                signedUpAt: data.user.created_at ?? null,
              },
            }
          : {}),
      });
    } catch (err: any) {
      console.error("check-subscription exception:", err.message);
      if (isUpstreamOutage(err)) return serveUnavailable(res);
      return res.json({ isPaid: false });
    }
  });

  // ---- Billing portal (by supabase user_id) ----
  app.post("/api/create-portal-session", async (req, res) => {
    try {
      const user_id = await getAuthedUserId(req);
      if (!user_id)
        return res.status(401).json({ error: "Unauthorized" });

      const stored = await getStoredSubscription(user_id);
      if (!stored) {
        return res
          .status(404)
          .json({ error: "No subscription found for this user" });
      }

      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
      const session = await stripe.billingPortal.sessions.create({
        customer: stored.stripe_customer_id,
        return_url: "https://tikbase.io/#/dashboard/billing",
      });
      return res.json({ url: session.url });
    } catch (err: any) {
      console.error("Portal session error:", err.message);
      return res.status(500).json({ error: "Failed to create portal session" });
    }
  });

  return httpServer;
}

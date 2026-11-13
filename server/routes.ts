import type { Express, Request } from "express";
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
import productDetailHandler from "../api/product-detail";
import videoTranscriptHandler from "../api/video-transcript";
import checkSubscriptionHandler from "../api/check-subscription";
import createCheckoutSessionHandler from "../api/create-checkout-session";
import verifySessionHandler from "../api/verify-session";
import createPortalSessionHandler from "../api/create-portal-session";

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

  // ---- Billing endpoints ----
  // These four used to be re-implemented here by hand, and the copies drifted.
  // This file's check-subscription imported isUpstreamOutage; the real
  // api/check-subscription.ts used it without importing it. So dev worked and
  // production threw a ReferenceError on every expired token from 2026-08-15,
  // found on 2026-11-12, with nothing here able to notice. They now run the
  // exact Vercel handlers, the same as every data endpoint above.
  //
  // The webhook above is the one exception: express.json() has already
  // consumed the request stream that api/stripe-webhook.ts reads its raw body
  // from, so it keeps its own copy and verifies against req.rawBody.
  const billingProxies: Array<
    ["get" | "post", string, (req: any, res: any) => unknown]
  > = [
    ["post", "/api/create-checkout-session", createCheckoutSessionHandler],
    ["post", "/api/verify-session", verifySessionHandler],
    ["get", "/api/check-subscription", checkSubscriptionHandler],
    ["post", "/api/create-portal-session", createPortalSessionHandler],
  ];
  for (const [method, path, handler] of billingProxies) {
    app[method](path, async (req, res) => {
      try {
        await handler(req as any, res as any);
      } catch (err: any) {
        console.error(`${path} (proxy) error:`, err?.message);
        if (!res.headersSent) res.status(500).json({ error: "Request failed" });
      }
    });
  }

  return httpServer;
}

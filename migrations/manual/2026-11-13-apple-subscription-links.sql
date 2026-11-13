-- apple_subscription_links: which TikBase account holds an Apple subscription
-- that was not bought through the app's own purchase call.
--
-- Applied to production on 2026-11-13, in one transaction. Verified after:
-- RLS on, no policies, grants to postgres and service_role only, and the
-- public anon key is refused both a read and an insert (401, 42501).
--
-- WHY THIS TABLE EXISTS
-- A purchase started in the iPhone app carries the buyer's account id inside
-- Apple's signature (appAccountToken), so the receipt itself says whose it is
-- and nothing needs storing. A purchase started anywhere else does not: an
-- offer code redeemed in the App Store, or a promoted purchase tapped on the
-- product page. Without a token the receipt proves someone paid, not who.
--
-- So the first TikBase account to present such a receipt claims it, here, and
-- no other account can. The primary key is the claim: two accounts racing to
-- insert the same original_transaction_id cannot both win.
--
-- Apple's notices about that subscription (renewed, refunded, expired) carry
-- no token either, and find the account through this table.
--
-- Read and written by the service role only. RLS is on with no policies, so
-- the anon and authenticated roles see nothing.

create table if not exists public.apple_subscription_links (
  original_transaction_id text primary key,
  user_id uuid not null,
  created_at timestamptz not null default now()
);

create index if not exists apple_subscription_links_user_id_idx
  on public.apple_subscription_links (user_id);

alter table public.apple_subscription_links enable row level security;

revoke all on public.apple_subscription_links from anon, authenticated;

import { useState } from 'react';
import { Check, X, Tag, Loader2 } from 'lucide-react';
import { useSubscription } from '@/hooks/use-subscription';
import { useAuth } from '@/lib/auth';

// Checked against what the API actually enforces, feature by feature, rather
// than inherited from the #19-era copy. Two claims were removed because they
// are not true: "Export data (CSV)" — there is no CSV export anywhere in the
// codebase — and "Unlimited bookmarks" as a Pro perk, when free users have the
// same unlimited bookmarks. Selling a button that does not exist is the fastest
// way to earn a refund request.
//
// Free-tier numbers are the server-side constants: FREE_ROWS 10 in
// api/top-products.ts, 5 creators, 3 videos, FREE_PRODUCTS 3 on a brand or
// creator page.
const FEATURES = [
  { name: "Today's top 10 products, all categories, 7-day window", free: true, pro: true },
  { name: 'Product, creator and brand search', free: true, pro: true },
  { name: 'Saved products and videos', free: true, pro: true },
  { name: 'All 400 ranked products per category', free: false, pro: true },
  { name: 'All 20 categories', free: false, pro: true },
  { name: 'Every timeframe: 7d, 14d, 30d, 90d, 180d, 1 year', free: false, pro: true },
  { name: '7-day and 30-day GMV, with measured-vs-modeled confidence', free: false, pro: true },
  { name: 'Opportunity badges — proven demand, few creators on it', free: false, pro: true },
  { name: 'Top Affiliates leaderboard with modeled creator GMV', free: false, pro: true },
  { name: 'Creator profiles — full catalogue and top videos', free: false, pro: true },
  { name: 'Brand pages — a shop\u2019s whole catalogue and its 30-day GMV', free: false, pro: true },
  { name: 'Every video driving a product, not just the first three', free: false, pro: true },
  { name: 'Video scripts — the spoken transcript of any video', free: false, pro: true },
  // Was "Stock levels and price history". Stock is on every product row; a
  // price history view has never been built, so it is not listed.
  { name: 'Stock levels', free: false, pro: true },
];

// Published list prices, checked 2026-08-15. The point of the row is not that
// we are cheaper — it is that it is one login instead of two tabs.
const COMPARISON = [
  { what: 'Product & sales data', them: 'Kalodata Starter', price: '$45.90/mo' },
  { what: 'Daily viral video picks', them: 'The Daily Virals', price: '~$55/mo' },
];

export default function PlansPage() {
  const [annual, setAnnual] = useState(false);
  const [promoCode, setPromoCode] = useState('');
  const monthlyPrice = 44.99;
  const annualPrice = 31.49;
  // What the annual plan actually charges, once, up front. Must stay equal to
  // the annual price in api/create-checkout-session.ts (12 x $31.49).
  const annualTotal = 377.88;
  const currentPrice = annual ? annualPrice : monthlyPrice;
  const savingsPercent = 30;

  const { markStripeOpened, isPaid, subscriptionStatus } = useSubscription();
  const { user, session } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Go through /api/create-checkout-session (not a raw Payment Link) so the
  // checkout carries client_reference_id = the Supabase user id. That's what
  // lets the webhook grant access after payment — Payment Links don't set it,
  // which left paying users stuck on the free tier.
  async function handleUpgrade() {
    if (!user?.id || !session?.access_token) {
      setError('Please sign in again to upgrade.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/create-checkout-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          plan: annual ? 'annual' : 'monthly',
          email: user.email,
          ...(promoCode.trim() ? { promo_code: promoCode.trim() } : {}),
        }),
      });
      const data = await res.json();
      // `message` is the sentence written for a person (already subscribed,
      // could not check the plan); `error` is the machine code.
      if (!res.ok || !data.url) throw new Error(data.message || data.error || 'Failed to start checkout');
      markStripeOpened();
      window.location.href = data.url;
    } catch (e: any) {
      setError(e.message || 'Something went wrong');
      setLoading(false);
    }
  }

  return (
    <div className="p-5 md:p-8 max-w-4xl mx-auto" data-testid="plans-page">
      <div className="mb-8 text-center">
        <h1 className="text-xl font-semibold text-foreground mb-1">Plans</h1>
        <p className="text-sm text-muted-foreground">
          Choose the plan that fits your needs
        </p>
      </div>

      {/* Billing toggle */}
      <div className="flex items-center justify-center gap-3 mb-8">
        <span
          className={`text-sm font-medium ${!annual ? 'text-foreground' : 'text-muted-foreground'}`}
        >
          Monthly
        </span>
        <button
          onClick={() => setAnnual(!annual)}
          className={`relative w-11 h-6 rounded-full transition-colors ${
            annual ? 'bg-primary' : 'bg-muted'
          }`}
          data-testid="billing-toggle"
        >
          <div
            className={`absolute top-0.5 w-5 h-5 rounded-full transition-transform ${
              annual ? 'translate-x-[22px] bg-primary-foreground' : 'translate-x-0.5 bg-foreground'
            }`}
          />
        </button>
        <span
          className={`text-sm font-medium ${annual ? 'text-foreground' : 'text-muted-foreground'}`}
        >
          Annual
        </span>
        {annual && (
          <span className="text-xs font-mono font-bold text-primary-bright bg-primary/10 px-2 py-0.5 rounded">
            Save {savingsPercent}%
          </span>
        )}
      </div>

      {/* Plan cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Free */}
        <div className="rounded-lg border border-border bg-card p-6" data-testid="plan-free">
          <h2 className="text-lg font-semibold text-foreground mb-1">Free</h2>
          <p className="text-sm text-muted-foreground mb-4">Basic access to TikBase</p>
          <div className="mb-6">
            <span className="text-3xl font-bold font-mono text-foreground">$0</span>
            <span className="text-sm text-muted-foreground ml-1">/mo</span>
          </div>
          {/* Not a button: it never did anything. And it only says "Current
              Plan" once the server has actually said so — it used to say it to
              Pro customers too. */}
          <div
            className="w-full h-10 rounded-md border border-border text-sm font-medium text-foreground flex items-center justify-center mb-6"
            data-testid="btn-current-plan"
          >
            {isPaid ? 'Included in Pro' : subscriptionStatus === 'known' ? 'Current Plan' : 'Free'}
          </div>
          <ul className="space-y-3">
            {FEATURES.map(f => (
              <li key={f.name} className="flex items-center gap-2.5">
                {f.free ? (
                  <Check size={14} className="text-primary flex-shrink-0" />
                ) : (
                  <X size={14} className="text-muted-foreground/40 flex-shrink-0" />
                )}
                <span
                  className={`text-sm ${
                    f.free ? 'text-foreground' : 'text-muted-foreground/60'
                  }`}
                >
                  {f.name}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* Pro */}
        <div
          className="rounded-lg border-2 border-primary/50 bg-card p-6 relative"
          data-testid="plan-pro"
        >
          <div
            className="absolute -top-3 left-6 px-3 py-0.5 rounded text-[10px] font-mono font-bold tracking-wider uppercase bg-primary text-primary-foreground"
          >
            Recommended
          </div>
          <h2 className="text-lg font-semibold text-foreground mb-1">Pro</h2>
          <p className="text-sm text-muted-foreground mb-4">Full access to all features</p>
          <div className="mb-1">
            <span className="text-3xl font-bold font-mono text-primary">
              ${currentPrice.toFixed(2)}
            </span>
            <span className="text-sm text-muted-foreground ml-1">/mo</span>
          </div>
          {annual && (
            // Said "Billed monthly at $31.49/mo". The annual plan is one charge
            // of $377.88 — $31.49 is that figure divided by twelve, not a bill.
            <p className="text-xs text-muted-foreground mb-4" data-testid="annual-billing-note">
              Billed yearly as one payment of <span className="font-mono">${annualTotal.toFixed(2)}</span>
            </p>
          )}
          {!annual && <div className="mb-4" />}
          {isPaid ? (
            <>
              <div
                className="w-full h-10 rounded-md border border-primary/30 bg-primary/10 text-sm font-bold text-primary-bright flex items-center justify-center mb-2"
                data-testid="pro-current-plan"
              >
                Your current plan
              </div>
              <a
                href="#/dashboard/billing"
                className="block text-center text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
                data-testid="link-manage-billing"
                onClick={(e) => {
                  e.preventDefault();
                  window.location.hash = '#/dashboard/billing';
                }}
              >
                Manage your subscription in Billing
              </a>
            </>
          ) : (
            <>
          {/* Discount code input */}
          <div className="mb-4">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Tag size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={promoCode}
                  onChange={e => setPromoCode(e.target.value)}
                  placeholder="Discount code"
                  className="w-full h-10 pl-9 pr-3 rounded-md text-sm border border-border bg-zinc-900/50 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/50"
                  data-testid="promo-code-input"
                />
              </div>
            </div>
          </div>

          <button
            onClick={handleUpgrade}
            disabled={loading}
            className="w-full h-10 rounded-md text-sm font-bold transition-colors mb-2 flex items-center justify-center gap-2 disabled:opacity-60 disabled:pointer-events-none bg-primary text-primary-foreground"
            data-testid="btn-upgrade"
          >
            {loading && <Loader2 size={15} className="animate-spin" />}
            {loading ? 'Starting checkout…' : 'Upgrade to Pro'}
          </button>
          {error && (
            <p className="text-xs text-red-400 mb-4 text-center" data-testid="upgrade-error">{error}</p>
          )}
            </>
          )}
          <div className="mb-6" />
          <ul className="space-y-3">
            {FEATURES.map(f => (
              <li key={f.name} className="flex items-center gap-2.5">
                <Check size={14} className="text-primary flex-shrink-0" />
                <span className="text-sm text-foreground">{f.name}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* The comparison, on the page where the decision gets made. */}
      <div className="mt-10 rounded-lg border border-border overflow-hidden max-w-3xl mx-auto" data-testid="price-comparison">
        <div className="px-5 py-3 border-b border-border bg-card/50">
          <p className="text-sm font-semibold text-foreground">What TikBase replaces</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Two subscriptions, two tabs, two logins — or one.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {COMPARISON.map(c => (
                <tr key={c.them} className="border-b border-border/60">
                  <td className="py-3 pl-5 pr-3 text-muted-foreground whitespace-nowrap">{c.what}</td>
                  <td className="py-3 px-3 text-foreground whitespace-nowrap">{c.them}</td>
                  <td className="py-3 pr-5 text-right font-mono text-foreground whitespace-nowrap">{c.price}</td>
                </tr>
              ))}
              <tr className="border-b border-border/60">
                <td className="py-3 pl-5 pr-3 font-semibold text-foreground whitespace-nowrap">Their total</td>
                <td className="py-3 px-3 text-muted-foreground whitespace-nowrap">two tabs, two logins</td>
                <td className="py-3 pr-5 text-right font-mono font-semibold text-foreground whitespace-nowrap">~$101/mo</td>
              </tr>
              <tr>
                <td className="py-3 pl-5 pr-3 font-semibold text-foreground whitespace-nowrap">TikBase Pro</td>
                <td className="py-3 px-3 text-muted-foreground whitespace-nowrap">one login</td>
                <td className="py-3 pr-5 text-right font-mono font-bold text-primary whitespace-nowrap">$44.99/mo</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="px-5 py-3 text-[11px] text-muted-foreground border-t border-border">
          Competitor prices are their published list prices, checked 2026-08-15.
        </p>
      </div>

      {/* Manage existing subscription */}
      <div className="mt-6 text-center">
        <a
          href="#/dashboard/billing"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors no-underline"
          onClick={(e) => {
            e.preventDefault();
            window.location.hash = '#/dashboard/billing';
          }}
        >
          Already subscribed? <span className="text-primary font-medium">Manage your subscription</span>
        </a>
      </div>
    </div>
  );
}

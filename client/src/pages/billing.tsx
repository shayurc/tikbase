import { useState } from 'react';
import { CreditCard, Receipt, Settings, Loader2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useSubscription } from '@/hooks/use-subscription';

export default function BillingPage() {
  const { user, session } = useAuth();
  const { isPaid, planSource, subscriptionStatus, refreshSubscription } = useSubscription();
  // Pro bought in the iPhone app is billed by Apple. There is no Stripe
  // customer behind it, so the portal button below would fail with "No
  // subscription found" — and we could not change the plan for them anyway.
  const appleBilled = isPaid && planSource === 'apple';
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retrying, setRetrying] = useState(false);

  // "Not known to be paying" is two different states. This page used to treat
  // both as Free, so a paying customer whose check failed read "You are on the
  // Free plan", "No payment method on file" and "No billing history" — three
  // false statements, with the Manage button hidden. Only say Free when the
  // server said so.
  const planUnknown = !isPaid && subscriptionStatus !== 'known';
  const isFree = !isPaid && !planUnknown;

  async function handleRetry() {
    setRetrying(true);
    try {
      await refreshSubscription();
    } finally {
      setRetrying(false);
    }
  }

  async function handleManageSubscription() {
    if (!user?.id || !session?.access_token) {
      setError('You must be signed in');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/create-portal-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Something went wrong');
        return;
      }
      window.location.href = data.url;
    } catch {
      setError('Failed to connect to server');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-5 md:p-8 max-w-3xl" data-testid="billing-page">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground mb-1">Billing</h1>
        <p className="text-sm text-muted-foreground">
          Manage your subscription and payment methods
        </p>
      </div>

      {/* Current Plan */}
      <div className="rounded-lg border border-border bg-card p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-foreground">Current Plan</h2>
          <span
            className="text-[10px] font-mono font-bold tracking-wider px-2 py-0.5 rounded uppercase"
            style={{ backgroundColor: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground))' }}
          >
            {isPaid ? 'Pro' : planUnknown ? '—' : 'Free'}
          </span>
        </div>
        <p className="text-sm text-muted-foreground mb-3" data-testid="current-plan-text">
          {isPaid
            ? 'You are on the TikBase Pro plan.'
            : planUnknown
              ? subscriptionStatus === 'loading'
                ? 'Checking your plan…'
                : 'We could not check your plan just now. This is a problem on our side, not a change to your subscription.'
              : 'You are on the Free plan. Upgrade to Pro for full access.'}
        </p>
        {planUnknown && subscriptionStatus === 'unknown' && (
          <button
            onClick={handleRetry}
            disabled={retrying}
            className="inline-flex items-center gap-2 h-8 px-4 rounded-md text-xs font-bold transition-colors disabled:opacity-50 border border-border text-foreground hover:bg-secondary"
            data-testid="btn-retry-plan"
          >
            {retrying && <Loader2 size={14} className="animate-spin" />}
            Check again
          </button>
        )}
        {isFree && (
          <a
            href="#/dashboard/plans"
            className="inline-flex items-center h-8 px-4 rounded-md text-xs font-bold transition-colors no-underline bg-primary text-primary-foreground"
            data-testid="btn-view-plans"
            onClick={(e) => {
              e.preventDefault();
              window.location.hash = '#/dashboard/plans';
            }}
          >
            View Plans
          </a>
        )}
      </div>

      {/* Billed by Apple: say where it is managed instead of offering a portal */}
      {appleBilled && (
        <div className="rounded-lg border border-border bg-card p-5 mb-4" data-testid="apple-billed">
          <div className="flex items-center gap-2 mb-3">
            <Settings size={16} className="text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Manage Subscription</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            You subscribed in the TikBase iPhone app, so Apple handles the billing. To change or cancel
            it, open Settings on your iPhone, tap your name, then Subscriptions.
          </p>
        </div>
      )}

      {/* Manage Subscription */}
      {isPaid && !appleBilled && (
        <div className="rounded-lg border border-border bg-card p-5 mb-4">
          <div className="flex items-center gap-2 mb-3">
            <Settings size={16} className="text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Manage Subscription</h2>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            Update payment methods, download invoices, or cancel your subscription.
          </p>
          <button
            onClick={handleManageSubscription}
            disabled={loading}
            className="inline-flex items-center gap-2 h-9 px-4 rounded-md text-xs font-bold transition-colors disabled:opacity-50 bg-primary text-primary-foreground"
            data-testid="btn-manage-subscription"
          >
            {loading && <Loader2 size={14} className="animate-spin" />}
            Manage Subscription
          </button>
          {error && (
            <p className="text-sm text-red-400 mt-2" data-testid="portal-error">{error}</p>
          )}
        </div>
      )}

      {/* Payment Method */}
      <div className="rounded-lg border border-border bg-card p-5 mb-4">
        <div className="flex items-center gap-2 mb-3">
          <CreditCard size={16} className="text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Payment Method</h2>
        </div>
        <div className="text-center py-8">
          <CreditCard size={28} className="mx-auto text-muted-foreground/30 mb-2" />
          <p className="text-sm text-muted-foreground">
            {appleBilled
              ? 'Your payment method is the one on your Apple Account.'
              : isPaid
              ? 'Manage payment methods via the subscription portal above.'
              : planUnknown
                ? '—'
                : 'No payment method on file.'}
          </p>
          {isFree && (
            <p className="text-xs text-muted-foreground/60 mt-1">
              Add a payment method when you upgrade to Pro.
            </p>
          )}
        </div>
      </div>

      {/* Billing History */}
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex items-center gap-2 mb-3">
          <Receipt size={16} className="text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Billing History</h2>
        </div>
        <div className="text-center py-8">
          <Receipt size={28} className="mx-auto text-muted-foreground/30 mb-2" />
          <p className="text-sm text-muted-foreground">
            {appleBilled
              ? 'Receipts are in your Apple Account purchase history.'
              : isPaid
              ? 'View invoices in the subscription portal.'
              : planUnknown
                ? '—'
                : 'No billing history.'}
          </p>
          {isFree && (
            <p className="text-xs text-muted-foreground/60 mt-1">
              Your invoices will appear here once you subscribe.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

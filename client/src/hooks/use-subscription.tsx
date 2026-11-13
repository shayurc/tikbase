import { useState, useEffect, useRef, useCallback, createContext, useContext, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { askSubscription } from '@/lib/subscription-check';

/**
 * 'loading'  first check for this account is still in flight
 * 'known'    the server answered; isPaid is a fact
 * 'unknown'  the server could not be asked; isPaid is whatever we last knew
 *
 * Pages that state the plan in words ("You are on the Free plan") must read
 * this — isPaid:false on its own does not say whether that is an answer.
 */
export type SubscriptionStatus = 'loading' | 'known' | 'unknown';

interface SubscriptionState {
  isPaid: boolean;
  subscriptionStatus: SubscriptionStatus;
  showPaywall: (feature?: string) => void;
  paywallVisible: boolean;
  paywallFeature: string | null;
  closePaywall: () => void;
  markStripeOpened: () => void;
  refreshSubscription: () => Promise<void>;
}

const SubscriptionContext = createContext<SubscriptionState>({
  isPaid: false,
  subscriptionStatus: 'loading',
  showPaywall: () => {},
  paywallVisible: false,
  paywallFeature: null,
  closePaywall: () => {},
  markStripeOpened: () => {},
  refreshSubscription: async () => {},
});

// How long after opening Stripe to keep re-checking on tab focus (5 minutes)
const RECHECK_WINDOW_MS = 5 * 60 * 1000;

export function SubscriptionProvider({ children }: { children: ReactNode }) {
  const { user, session, loading: authLoading } = useAuth();
  const [isPaid, setIsPaid] = useState(false);
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus>('loading');
  const [paywallVisible, setPaywallVisible] = useState(false);
  const stripeOpenedAt = useRef<number | null>(null);

  // Keep the latest access token in a ref so event handlers (visibility) always
  // read the current token without re-subscribing.
  const tokenRef = useRef<string | undefined>(session?.access_token);
  tokenRef.current = session?.access_token;

  // Checks overlap (login, token refresh, tab focus, the success page). Only
  // the newest may write, or a slow failure could land after a fast success.
  const checkSeq = useRef(0);
  // Whose answer isPaid currently holds, so a token refresh for the same
  // account keeps it while a different account starts from scratch.
  const checkedUserId = useRef<string | null>(null);

  const checkSubscription = useCallback(async (token: string) => {
    const seq = ++checkSeq.current;
    const answer = await askSubscription(token);
    if (seq !== checkSeq.current) return;
    if (answer.known) {
      setIsPaid(answer.isPaid);
      setSubscriptionStatus('known');
    } else {
      // Could not ask. isPaid is deliberately left alone: a failed request is
      // not evidence that a paying customer stopped paying.
      setSubscriptionStatus('unknown');
    }
  }, []);

  // Stable identity: the success page lists this in an effect's deps, and a
  // new function every render re-ran that effect (and re-posted to
  // /api/verify-session) each time this provider updated.
  const refreshSubscription = useCallback(async () => {
    if (tokenRef.current) await checkSubscription(tokenRef.current);
  }, [checkSubscription]);

  // Initial check on login, and again whenever the token is refreshed
  const userId = user?.id ?? null;
  useEffect(() => {
    if (authLoading) return; // not signed-out yet, just not known yet
    const token = session?.access_token;
    if (!token) {
      // Signed out is an answer, not an unknown.
      checkSeq.current++;
      checkedUserId.current = null;
      setIsPaid(false);
      setSubscriptionStatus('known');
      return;
    }
    if (checkedUserId.current !== userId) {
      checkedUserId.current = userId;
      setIsPaid(false);
      setSubscriptionStatus('loading');
    }
    checkSubscription(token);
  }, [authLoading, session?.access_token, userId, checkSubscription]);

  // Re-check when user returns to tab after visiting Stripe
  useEffect(() => {
    if (!user?.id) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (!stripeOpenedAt.current) return;
      const elapsed = Date.now() - stripeOpenedAt.current;
      if (elapsed > RECHECK_WINDOW_MS) {
        stripeOpenedAt.current = null;
        return;
      }
      if (tokenRef.current) checkSubscription(tokenRef.current);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [user?.id]);

  // Call this whenever a Stripe payment link is opened
  const markStripeOpened = () => {
    stripeOpenedAt.current = Date.now();
  };

  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);

  function showPaywall(feature?: string) {
    setPaywallFeature(feature || null);
    setPaywallVisible(true);
  }

  function closePaywall() {
    setPaywallVisible(false);
    setPaywallFeature(null);
  }

  return (
    <SubscriptionContext.Provider value={{
      isPaid, subscriptionStatus, showPaywall, paywallVisible, paywallFeature, closePaywall, markStripeOpened, refreshSubscription,
    }}>
      {children}
    </SubscriptionContext.Provider>
  );
}

export function useSubscription() {
  return useContext(SubscriptionContext);
}

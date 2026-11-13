import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabaseAuth } from './supabaseAuth';
import { getReferral, clearReferral, shouldAttachReferral } from './referral';

interface AuthState {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signInWithEmail: (email: string, password: string) => Promise<{ error: Error | null }>;
  signUpWithEmail: (email: string, password: string) => Promise<{ error: Error | null }>;
  signInWithGoogle: () => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  /** True while the visitor arrived from a password-reset email. */
  recovering: boolean;
  requestPasswordReset: (email: string) => Promise<{ error: Error | null }>;
  updatePassword: (password: string) => Promise<{ error: Error | null }>;
  cancelRecovery: () => void;
}

/**
 * Did this page load come from a reset email?
 *
 * Two signals, because either can be missing. `?reset=1` is the redirect we
 * ask for; if that URL is not on the project's allow-list Supabase falls back
 * to the site URL and drops it. `type=recovery` is what Supabase itself puts in
 * the fragment, which the client strips once it has read the tokens — so it is
 * read here, at first render, and the PASSWORD_RECOVERY event below is the
 * third net.
 */
function arrivedFromResetEmail(): boolean {
  try {
    return (
      new URLSearchParams(window.location.search).has('reset') ||
      /(^|[#&?])type=recovery(&|$)/.test(window.location.hash)
    );
  } catch {
    return false;
  }
}

const AuthContext = createContext<AuthState>({
  session: null,
  user: null,
  loading: true,
  signInWithEmail: async () => ({ error: null }),
  signUpWithEmail: async () => ({ error: null }),
  signInWithGoogle: async () => ({ error: null }),
  signOut: async () => {},
  recovering: false,
  requestPasswordReset: async () => ({ error: null }),
  updatePassword: async () => ({ error: null }),
  cancelRecovery: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [recovering, setRecovering] = useState(arrivedFromResetEmail);

  useEffect(() => {
    supabaseAuth.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const { data: { subscription } } = supabaseAuth.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') setRecovering(true);
      if (event === 'SIGNED_IN' && session?.user) {
        // A Google sign-up's referral code. Deferred: calling another auth
        // method from inside this callback can deadlock the client.
        const u = session.user;
        const referral = getReferral();
        if (
          referral &&
          shouldAttachReferral({
            hasStoredCode: true,
            alreadyAttributed: Boolean((u.user_metadata as any)?.referral?.code),
            accountCreatedAt: u.created_at,
          })
        ) {
          setTimeout(() => {
            supabaseAuth.auth
              .updateUser({ data: { referral } })
              .then(({ error }) => { if (!error) clearReferral(); })
              .catch(() => {});
          }, 0);
        }
      }
      setSession(session);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  async function signInWithEmail(email: string, password: string) {
    const { error } = await supabaseAuth.auth.signInWithPassword({ email, password });
    return { error: error as Error | null };
  }

  async function signUpWithEmail(email: string, password: string) {
    // Attribution rides along in user_metadata, which the user's own token can
    // write. app_metadata is service-role only and is where the webhook keeps
    // the subscription — a referral code is a claim about where someone came
    // from, not an entitlement, so it belongs on the user side.
    const referral = getReferral();
    const { error } = await supabaseAuth.auth.signUp({
      email,
      password,
      options: referral ? { data: { referral } } : undefined,
    });
    if (!error && referral) clearReferral();
    return { error: error as Error | null };
  }

  async function signInWithGoogle() {
    // The OAuth round trip loses localStorage on some browsers, so the code
    // goes out on the redirect URL and captureReferral() picks it back up.
    const referral = getReferral();
    const redirectTo = referral
      ? `${window.location.origin}/?via=${encodeURIComponent(referral.code)}`
      : window.location.origin;
    const { error } = await supabaseAuth.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo },
    });
    return { error: error as Error | null };
  }

  async function signOut() {
    // signOut() revokes the session on the server first, and when that request
    // fails it returns an error and LEAVES THE LOCAL SESSION IN PLACE. The old
    // code ignored the error and cleared React state anyway: the app looked
    // signed out, and a reload signed the same person back in — on a shared
    // computer, the next person. If the server cannot be reached, at least
    // forget the session on this device.
    const { error } = await supabaseAuth.auth.signOut();
    if (error) {
      await supabaseAuth.auth.signOut({ scope: 'local' }).catch(() => {});
    }
    setSession(null);
  }

  async function requestPasswordReset(email: string) {
    const { error } = await supabaseAuth.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/?reset=1`,
    });
    return { error: error as Error | null };
  }

  /** Drop the reset markers from the address bar and go back to the app. */
  function cancelRecovery() {
    setRecovering(false);
    try {
      window.history.replaceState(null, '', `${window.location.pathname}#/`);
    } catch {
      /* address bar is cosmetic here */
    }
  }

  async function updatePassword(password: string) {
    const { error } = await supabaseAuth.auth.updateUser({ password });
    if (!error) cancelRecovery();
    return { error: error as Error | null };
  }

  return (
    <AuthContext.Provider value={{
      session,
      user: session?.user ?? null,
      loading,
      signInWithEmail,
      signUpWithEmail,
      signInWithGoogle,
      signOut,
      recovering,
      requestPasswordReset,
      updatePassword,
      cancelRecovery,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

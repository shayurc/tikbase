import { useState } from 'react';
import { User, KeyRound, Trash2, Loader2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';

// What this page used to be: a Name and Email form with a Save button that had
// no handler, default-category and default-timeframe selects that were stored
// nowhere, three notification switches for emails that are never sent, and a
// Delete Account button wired to nothing. None of it did anything, and all of
// it looked like it did.
//
// Everything on the page now does what it says. The preference and
// notification sections are gone rather than faked; they can come back when
// there is something behind them.
const CONFIRM_WORD = 'DELETE'; // must match api/delete-account.ts

export default function SettingsPage() {
  const { user, session, requestPasswordReset, signOut } = useAuth();

  const [resetState, setResetState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [resetError, setResetError] = useState('');

  const [confirm, setConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const email = user?.email ?? '';
  // Google sign-ins have no password here to reset.
  const provider = (user?.app_metadata as { provider?: string } | undefined)?.provider;
  const hasPassword = !provider || provider === 'email';

  async function handleSendReset() {
    if (!email) return;
    setResetError('');
    setResetState('sending');
    const { error } = await requestPasswordReset(email);
    if (error) {
      setResetError(error.message);
      setResetState('idle');
    } else {
      setResetState('sent');
    }
  }

  async function handleDelete() {
    if (!session?.access_token || confirm !== CONFIRM_WORD) return;
    setDeleteError('');
    setDeleting(true);
    try {
      const res = await fetch('/api/delete-account', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ confirm }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.deleted) {
        setDeleteError(data.message || 'Your account could not be deleted. Nothing was changed.');
        setDeleting(false);
        return;
      }
      await signOut();
      window.location.hash = '#/';
    } catch {
      setDeleteError('We could not reach the server. Nothing was changed.');
      setDeleting(false);
    }
  }

  return (
    <div className="p-5 md:p-8 max-w-3xl" data-testid="settings-page">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-foreground mb-1">Settings</h1>
        <p className="text-sm text-muted-foreground">Your account</p>
      </div>

      {/* Account */}
      <div className="rounded-lg border border-border bg-card px-5 py-4 mb-4">
        <div className="flex items-center gap-2 mb-4">
          <User size={16} className="text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Account</h2>
        </div>
        <dl className="space-y-3">
          <div>
            <dt className="text-xs font-medium text-muted-foreground mb-1">Email</dt>
            <dd className="text-sm font-mono text-foreground break-all" data-testid="account-email">
              {email || '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground mb-1">Sign-in method</dt>
            <dd className="text-sm text-foreground" data-testid="account-provider">
              {hasPassword ? 'Email and password' : provider === 'google' ? 'Google' : provider}
            </dd>
          </div>
        </dl>
      </div>

      {/* Password */}
      {hasPassword && (
        <div className="rounded-lg border border-border bg-card px-5 py-4 mb-4">
          <div className="flex items-center gap-2 mb-3">
            <KeyRound size={16} className="text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Password</h2>
          </div>
          {resetState === 'sent' ? (
            <p className="text-sm text-muted-foreground" data-testid="reset-sent">
              A link to choose a new password is on its way to <span className="font-mono text-foreground">{email}</span>.
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground mb-3">
                We will email you a link to choose a new password.
              </p>
              <button
                onClick={handleSendReset}
                disabled={resetState === 'sending' || !email}
                className="inline-flex items-center gap-2 h-9 px-4 rounded-md text-xs font-bold transition-colors disabled:opacity-50 bg-primary text-primary-foreground"
                data-testid="btn-send-reset"
              >
                {resetState === 'sending' && <Loader2 size={14} className="animate-spin" />}
                Email me a reset link
              </button>
              {resetError && <p className="text-sm text-destructive mt-2">{resetError}</p>}
            </>
          )}
        </div>
      )}

      {/* Danger Zone */}
      <div className="rounded-lg border border-destructive/30 bg-card px-5 py-4">
        <div className="flex items-center gap-2 mb-3">
          <Trash2 size={16} className="text-destructive" />
          <h2 className="text-sm font-semibold text-destructive">Delete Account</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-3">
          Permanently deletes your TikBase account. This cannot be undone. If you have a Pro subscription,
          cancel it in Billing first.
        </p>
        <label htmlFor="delete-confirm" className="block text-xs font-medium text-muted-foreground mb-1.5">
          Type <span className="font-mono text-foreground">{CONFIRM_WORD}</span> to confirm
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            id="delete-confirm"
            type="text"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            autoComplete="off"
            className="h-9 px-3 rounded-md text-sm font-mono border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-destructive sm:w-48"
            data-testid="input-delete-confirm"
          />
          <button
            onClick={handleDelete}
            disabled={confirm !== CONFIRM_WORD || deleting}
            className="inline-flex items-center justify-center gap-2 h-9 px-4 rounded-md text-xs font-bold bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-40 disabled:pointer-events-none"
            data-testid="btn-delete-account"
          >
            {deleting && <Loader2 size={14} className="animate-spin" />}
            Delete Account
          </button>
        </div>
        {deleteError && (
          <p className="text-sm text-destructive mt-2" data-testid="delete-error">{deleteError}</p>
        )}
      </div>
    </div>
  );
}

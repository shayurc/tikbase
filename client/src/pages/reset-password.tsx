import { useState } from 'react';
import { useAuth } from '@/lib/auth';

/** Shortest password accepted here. Supabase's own floor is lower. */
export const MIN_PASSWORD_LENGTH = 8;

/** Why a new password cannot be used, or null when it can. Pure, so it is tested. */
export function passwordProblem(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password !== confirm) return 'The two passwords do not match.';
  return null;
}

// Shown instead of the router while `recovering` is true (see App.tsx). It is
// not a route: the reset email returns to `/#access_token=...&type=recovery`,
// which the hash router reads as a path and answers with the 404 page.
export default function ResetPasswordPage() {
  const { user, loading, updatePassword, cancelRecovery } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const problem = passwordProblem(password, confirm);
    if (problem) {
      setError(problem);
      return;
    }
    setError('');
    setSaving(true);
    const { error } = await updatePassword(password);
    // On success the provider leaves recovery mode and this page unmounts.
    if (error) {
      setError(error.message);
      setSaving(false);
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ backgroundColor: '#0e0e10', fontFamily: "'Inter', sans-serif" }}
    >
      <div className="w-full max-w-md">
        <div className="text-center mb-10">
          <span className="text-white font-black text-2xl tracking-tighter">TikBase</span>
          <h1 className="font-['Space_Grotesk'] text-3xl font-bold text-white mt-6 mb-2">Choose a new password</h1>
        </div>

        <div className="bg-[#19191c] rounded-2xl p-8">
          {loading ? (
            <p className="text-[#adaaad] text-sm" data-testid="reset-checking">Checking your link...</p>
          ) : !user ? (
            // The link signs the visitor in. No session means it was already
            // used, has expired, or was opened in a different browser.
            <div data-testid="reset-link-invalid">
              <p className="text-[#adaaad] text-sm leading-relaxed mb-5">
                This reset link has expired or was already used. Request a new one and open it in this browser.
              </p>
              <button
                onClick={() => {
                  cancelRecovery();
                  window.location.hash = '#/forgot-password';
                }}
                className="w-full py-3 rounded-full bg-primary text-primary-foreground font-['Space_Grotesk'] font-bold text-sm hover:brightness-110 active:scale-95 transition-all"
              >
                Request a new link
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="new-password" className="block text-[#8a8a8a] text-xs font-['Space_Grotesk'] mb-2 uppercase tracking-wider">New password</label>
                <input
                  id="new-password"
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                  className="w-full px-4 py-3 rounded-lg bg-[#262528] border border-[#48474a]/15 text-white text-sm focus:outline-none focus:border-primary/40 transition-colors"
                  placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                  data-testid="input-new-password"
                />
              </div>
              <div>
                <label htmlFor="confirm-password" className="block text-[#8a8a8a] text-xs font-['Space_Grotesk'] mb-2 uppercase tracking-wider">Repeat it</label>
                <input
                  id="confirm-password"
                  type="password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  required
                  autoComplete="new-password"
                  className="w-full px-4 py-3 rounded-lg bg-[#262528] border border-[#48474a]/15 text-white text-sm focus:outline-none focus:border-primary/40 transition-colors"
                  data-testid="input-confirm-password"
                />
              </div>

              {error && <p className="text-[#ff7351] text-sm" data-testid="reset-error">{error}</p>}

              <button
                type="submit"
                disabled={saving}
                className="w-full py-3 rounded-full bg-primary text-primary-foreground font-['Space_Grotesk'] font-bold text-sm hover:brightness-110 active:scale-95 transition-all disabled:opacity-60"
                data-testid="btn-save-password"
              >
                {saving ? 'Saving...' : 'Save new password'}
              </button>
              <button
                type="button"
                onClick={cancelRecovery}
                className="w-full text-center text-[#adaaad] text-xs bg-transparent border-none cursor-pointer hover:text-white"
              >
                Keep my current password
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

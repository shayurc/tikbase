import { useState } from 'react';
import { Link } from 'wouter';
import { useAuth } from '@/lib/auth';

// There was no way back into an account with a forgotten password: no link on
// the login page, no reset flow anywhere. A paying customer who forgot theirs
// could not reach the product or the billing portal to cancel.
//
// Styled to match login.tsx and signup.tsx, which it sits between.
export default function ForgotPasswordPage() {
  const { requestPasswordReset } = useAuth();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const { error } = await requestPasswordReset(email.trim());
    setLoading(false);
    // Only a failure to SEND is shown (rate limit, network). Whether the
    // address has an account is never revealed: the confirmation is the same
    // either way, so this form cannot be used to test who is a customer.
    if (error) setError(error.message);
    else setSent(true);
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ backgroundColor: '#0e0e10', fontFamily: "'Inter', sans-serif" }}
    >
      <div className="w-full max-w-md">
        <div className="text-center mb-10">
          <Link href="/" className="text-white font-black text-2xl tracking-tighter no-underline">TikBase</Link>
          <h1 className="font-['Space_Grotesk'] text-3xl font-bold text-white mt-6 mb-2">Reset your password</h1>
          <p className="text-[#adaaad] text-sm">We will email you a link to choose a new one</p>
        </div>

        <div className="bg-[#19191c] rounded-2xl p-8">
          {sent ? (
            <p className="text-[#adaaad] text-sm leading-relaxed" data-testid="reset-sent">
              If there is an account for <span className="text-white">{email.trim()}</span>, a reset link is on its
              way. It can take a minute, and it may land in spam.
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="reset-email" className="block text-[#8a8a8a] text-xs font-['Space_Grotesk'] mb-2 uppercase tracking-wider">Email</label>
                <input
                  id="reset-email"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  className="w-full px-4 py-3 rounded-lg bg-[#262528] border border-[#48474a]/15 text-white text-sm focus:outline-none focus:border-primary/40 transition-colors"
                  placeholder="you@example.com"
                  data-testid="input-reset-email"
                />
              </div>

              {error && <p className="text-[#ff7351] text-sm">{error}</p>}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 rounded-full bg-primary text-primary-foreground font-['Space_Grotesk'] font-bold text-sm hover:brightness-110 active:scale-95 transition-all disabled:opacity-60"
                data-testid="btn-send-reset"
              >
                {loading ? 'Sending...' : 'Send reset link'}
              </button>
            </form>
          )}
        </div>

        <p className="text-center mt-6 text-[#adaaad] text-sm">
          <Link href="/login" className="text-primary font-medium no-underline hover:underline">Back to sign in</Link>
        </p>
      </div>
    </div>
  );
}

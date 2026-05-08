'use client';

import { useState } from 'react';
import { Mail, Lock, X, User } from 'lucide-react';
import { registerEmail, loginEmail } from '@/lib/api';

interface EmailAuthProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function EmailAuth({ isOpen, onClose, onSuccess }: EmailAuthProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (mode === 'register') {
        await registerEmail(email, password, displayName || undefined);
      } else {
        await loginEmail(email, password);
      }
      onSuccess();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="relative w-full max-w-md rounded-lg bg-[#141414] border border-[#262626] p-8">
        <button onClick={onClose} className="absolute right-4 top-4 text-[#666] hover:text-[#fafafa] transition-colors">
          <X className="h-5 w-5" />
        </button>

        <h2 className="mb-6 text-2xl font-medium text-[#fafafa]">
          {mode === 'login' ? 'Sign In' : 'Create Account'}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'register' && (
            <div className="relative">
              <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#666]" />
              <input
                type="text"
                placeholder="Display name (optional)"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full rounded-lg bg-[#141414] border border-[#262626] py-3 pl-10 pr-4 text-[#fafafa] placeholder-[#666] outline-none focus:border-[#444]"
              />
            </div>
          )}

          <div className="relative">
            <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#666]" />
            <input
              type="email"
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full rounded-lg bg-[#141414] border border-[#262626] py-3 pl-10 pr-4 text-[#fafafa] placeholder-[#666] outline-none focus:border-[#444]"
            />
          </div>

          <div className="relative">
            <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#666]" />
            <input
              type="password"
              placeholder="Password (8+ characters)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              className="w-full rounded-lg bg-[#141414] border border-[#262626] py-3 pl-10 pr-4 text-[#fafafa] placeholder-[#666] outline-none focus:border-[#444]"
            />
          </div>

          {error && (
            <p className="text-sm text-[#ef4444]">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-[#fafafa] py-3 font-medium text-[#0a0a0a] transition-colors hover:bg-[#e5e5e5] disabled:opacity-50 active:scale-[0.98]"
          >
            {loading ? 'Please wait...' : mode === 'login' ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        <div className="mt-4 text-center text-sm text-[#666]">
          {mode === 'login' ? (
            <>
              Don&apos;t have an account?{' '}
              <button onClick={() => { setMode('register'); setError(''); }} className="text-[#a1a1a1] hover:text-[#fafafa] transition-colors">
                Sign up
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button onClick={() => { setMode('login'); setError(''); }} className="text-[#a1a1a1] hover:text-[#fafafa] transition-colors">
                Sign in
              </button>
            </>
          )}
        </div>

        <div className="mt-4 text-center text-xs text-[#666]">
          Or connect a Solana wallet for crypto payments
        </div>
      </div>
    </div>
  );
}

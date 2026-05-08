'use client';

import { useState, useEffect, useCallback } from 'react';
import { Wallet, ArrowDownToLine, ArrowUpFromLine, RefreshCw, CreditCard, Key, Copy, Trash2, Plus } from 'lucide-react';
import { api, createCheckout, listApiKeys, createApiKey, revokeApiKey, getModels, type ApiKeyInfo, type Model, type BalanceResponse } from '@/lib/api';

// USDT first = platform default. UI ordering matches the backend's
// accepted_tokens config so the picker lines up with x402 challenge order.
const SUPPORTED_CURRENCIES = ['USDT', 'USDC'] as const;
type Currency = typeof SUPPORTED_CURRENCIES[number];

export default function AccountPage() {
  const [balance, setBalance] = useState<BalanceResponse | null>(null);
  const [depositAmount, setDepositAmount] = useState('');
  const [depositTx, setDepositTx] = useState('');
  const [depositCurrency, setDepositCurrency] = useState<Currency>('USDT');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawCurrency, setWithdrawCurrency] = useState<Currency>('USDT');
  const [loading, setLoading] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);

  // API Keys state
  const [apiKeys, setApiKeys] = useState<ApiKeyInfo[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [newKeyModel, setNewKeyModel] = useState('');
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyResult, setNewKeyResult] = useState<string | null>(null);
  const [keyLoading, setKeyLoading] = useState(false);

  const fetchBalance = useCallback(async () => {
    try {
      const data = await api.getBalance();
      setBalance(data);
    } catch { /* not logged in */ }
  }, []);

  const fetchApiKeys = useCallback(async () => {
    try {
      const keys = await listApiKeys();
      setApiKeys(keys);
    } catch { /* not logged in */ }
  }, []);

  const fetchModels = useCallback(async () => {
    try {
      const data = await getModels({ limit: 100 });
      setModels(data.models);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchBalance();
    fetchApiKeys();
    fetchModels();
  }, [fetchBalance, fetchApiKeys, fetchModels]);

  const formatStablecoin = (micro: number, currency: string) =>
    `${(micro / 1_000_000).toFixed(2)} ${currency}`;

  const totalBalanceUsd = (b: BalanceResponse | null) =>
    b ? b.balances.reduce((sum, x) => sum + x.balance, 0) : 0;

  const handleDeposit = async () => {
    if (!depositTx || !depositAmount) return;
    setLoading(true);
    try {
      await api.submitDeposit(
        depositTx,
        Math.round(parseFloat(depositAmount) * 1_000_000),
        depositCurrency,
      );
      setDepositTx(''); setDepositAmount('');
      await fetchBalance();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Deposit failed');
    } finally { setLoading(false); }
  };

  const handleWithdraw = async () => {
    if (!withdrawAmount) return;
    setLoading(true);
    try {
      await api.requestWithdraw(
        Math.round(parseFloat(withdrawAmount) * 1_000_000),
        '',
        withdrawCurrency,
      );
      setWithdrawAmount('');
      await fetchBalance();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Withdrawal failed');
    } finally { setLoading(false); }
  };

  const handleCheckout = async (pack: string) => {
    setCheckoutLoading(pack);
    try {
      const { checkout_url } = await createCheckout(pack);
      window.location.href = checkout_url;
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Checkout failed');
    } finally {
      setCheckoutLoading(null);
    }
  };

  const handleCreateKey = async () => {
    if (!newKeyModel) return;
    setKeyLoading(true);
    setNewKeyResult(null);
    try {
      const result = await createApiKey(newKeyModel, newKeyName || undefined);
      setNewKeyResult(result.key);
      setNewKeyName('');
      await fetchApiKeys();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to create key');
    } finally {
      setKeyLoading(false);
    }
  };

  const handleRevokeKey = async (id: string) => {
    if (!confirm('Revoke this API key? This cannot be undone.')) return;
    try {
      await revokeApiKey(id);
      await fetchApiKeys();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to revoke key');
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <div className="max-w-2xl mx-auto py-12 px-4">
      <h1 className="text-3xl font-medium mb-8">Account</h1>

      <div className="bg-[#141414] border border-[#262626] rounded-xl p-8 mb-8">
        <div className="flex items-center gap-3 mb-4">
          <Wallet className="w-6 h-6 text-[#fafafa]" />
          <span className="text-[#a1a1a1] text-sm font-medium">Stablecoin Balances</span>
          <button onClick={fetchBalance} className="ml-auto text-[#666] hover:text-[#fafafa] transition-colors"><RefreshCw className="w-4 h-4" /></button>
        </div>
        {balance && balance.balances.length > 0 ? (
          <div className="space-y-2">
            {balance.balances.map((b) => (
              <div key={b.currency} className="flex items-baseline justify-between">
                <span className="text-sm text-[#a1a1a1] font-medium">{b.currency}</span>
                <span className="text-3xl font-medium text-[#00E5A0] font-mono">
                  {formatStablecoin(b.balance, b.currency)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-5xl font-medium text-[#00E5A0] font-mono mb-2">{'\u2014'}</p>
        )}
        {balance && balance.pending_earnings > 0 && (
          <p className="text-sm text-[#00E5A0]/70 mt-3">
            +${(balance.pending_earnings / 1_000_000).toFixed(2)} creator earnings (paid in deposit currency)
          </p>
        )}
        {balance && totalBalanceUsd(balance) === 0 && (
          <p className="text-xs text-[#666] mt-2">Deposit USDT or USDC on Solana to start chatting.</p>
        )}
      </div>

      {/* API Keys */}
      <div className="bg-[#141414] border border-[#262626] rounded-lg p-6 mb-6">
        <h2 className="text-lg font-medium mb-4 flex items-center gap-2">
          <Key className="w-5 h-5 text-[#fafafa]" /> API Keys
        </h2>
        <p className="text-sm text-[#a1a1a1] mb-4">
          Create API keys to access models via the OpenAI-compatible endpoint.
        </p>

        {/* Create new key */}
        <div className="flex gap-2 mb-4">
          <select
            value={newKeyModel}
            onChange={(e) => setNewKeyModel(e.target.value)}
            className="flex-1 bg-[#141414] border border-[#262626] rounded-lg px-3 py-2 text-sm text-[#fafafa] focus:border-[#444] focus:outline-none"
          >
            <option value="">Select a model...</option>
            {models.filter(m => m.status === 'live').map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          <input
            type="text"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            placeholder="Key name (optional)"
            className="w-40 bg-[#141414] border border-[#262626] rounded-lg px-3 py-2 text-sm text-[#fafafa] focus:border-[#444] focus:outline-none"
          />
          <button
            onClick={handleCreateKey}
            disabled={!newKeyModel || keyLoading}
            className="flex items-center gap-1.5 rounded-lg bg-[#fafafa] px-4 py-2 text-sm font-medium text-[#0a0a0a] hover:bg-[#e5e5e5] disabled:opacity-50 active:scale-[0.98] transition-colors"
          >
            <Plus className="w-4 h-4" /> Create
          </button>
        </div>

        {/* New key result */}
        {newKeyResult && (
          <div className="mb-4 rounded-lg border border-[#00E5A0]/20 bg-[#00E5A0]/10 p-4">
            <p className="text-xs text-[#00E5A0] mb-2">API key created. Copy it now — it won&apos;t be shown again:</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-lg bg-[#111] px-3 py-2 text-sm font-mono text-[#00E5A0] break-all">
                {newKeyResult}
              </code>
              <button
                onClick={() => copyToClipboard(newKeyResult)}
                className="rounded-lg bg-[#1a1a1a] p-2 hover:bg-[#222] transition-colors"
                title="Copy"
              >
                <Copy className="w-4 h-4 text-[#a1a1a1]" />
              </button>
            </div>
          </div>
        )}

        {/* Existing keys */}
        {apiKeys.length > 0 ? (
          <div className="space-y-2">
            {apiKeys.map((key) => (
              <div key={key.id} className="flex items-center justify-between rounded-lg bg-[#1a1a1a] px-4 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <code className="text-sm font-mono text-[#a1a1a1]">{key.key_prefix}...</code>
                    {key.name && <span className="text-xs text-[#666]">{key.name}</span>}
                    {!key.is_active && <span className="text-xs text-[#ef4444]">revoked</span>}
                  </div>
                  <p className="text-xs text-[#666] mt-0.5">
                    {key.model_name} &middot; Created {new Date(key.created_at).toLocaleDateString()}
                    {key.last_used_at && ` \u00b7 Last used ${new Date(key.last_used_at).toLocaleDateString()}`}
                  </p>
                </div>
                {key.is_active && (
                  <button
                    onClick={() => handleRevokeKey(key.id)}
                    className="rounded-lg p-2 text-[#666] hover:bg-[#222] hover:text-[#ef4444] transition-colors"
                    title="Revoke key"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-[#666]">No API keys yet.</p>
        )}
      </div>

      <div className="bg-[#141414] border border-[#262626] rounded-lg p-6 mb-6">
        <h2 className="text-lg font-medium mb-4 flex items-center gap-2">
          <CreditCard className="w-5 h-5 text-[#fafafa]" /> Buy Credits with Card
        </h2>
        <p className="text-sm text-[#a1a1a1] mb-4">Purchase credits instantly with a credit or debit card.</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { pack: '5', label: '$5', credits: '5M' },
            { pack: '10', label: '$10', credits: '10M' },
            { pack: '25', label: '$25', credits: '25M' },
            { pack: '50', label: '$50', credits: '50M' },
          ].map((p) => (
            <button
              key={p.pack}
              onClick={() => handleCheckout(p.pack)}
              disabled={!!checkoutLoading}
              className="flex flex-col items-center gap-1 rounded-lg border border-[#262626] bg-[#141414] p-4 transition-colors hover:border-[#333] disabled:opacity-50 active:scale-[0.98]"
            >
              <span className="text-xl font-medium text-[#fafafa]">{p.label}</span>
              <span className="text-xs text-[#666]">{p.credits} credits</span>
              {checkoutLoading === p.pack && <span className="text-xs text-[#a1a1a1]">Redirecting...</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-[#141414] border border-[#262626] rounded-lg p-6 mb-6">
        <h2 className="text-lg font-medium mb-4 flex items-center gap-2">
          <ArrowDownToLine className="w-5 h-5 text-[#00E5A0]" /> Deposit
        </h2>
        <p className="text-2xl font-medium text-[#fafafa] mb-1">{depositCurrency} on Solana only</p>
        <p className="text-sm text-[#a1a1a1] mb-4">
          Sending {depositCurrency} on Ethereum, Tron, or any other chain will be lost forever. Verify the chain in your wallet before signing.
        </p>
        <div className="space-y-3">
          <div className="flex gap-2">
            {SUPPORTED_CURRENCIES.map((c) => (
              <button
                key={c}
                onClick={() => setDepositCurrency(c)}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                  depositCurrency === c
                    ? 'border-[#00E5A0] bg-[#00E5A0]/10 text-[#00E5A0]'
                    : 'border-[#262626] text-[#a1a1a1] hover:border-[#333]'
                }`}
              >
                {c}
                {c === 'USDT' && <span className="ml-1 text-[10px] text-[#666]">(recommended)</span>}
              </button>
            ))}
          </div>
          <input type="number" step="0.01" placeholder={`Amount (${depositCurrency})`} value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} className="w-full bg-[#141414] border border-[#262626] rounded-lg px-4 py-3 text-[#fafafa] focus:border-[#444] focus:outline-none" />
          <input type="text" placeholder="Transaction signature" value={depositTx} onChange={(e) => setDepositTx(e.target.value)} className="w-full bg-[#141414] border border-[#262626] rounded-lg px-4 py-3 text-[#fafafa] focus:border-[#444] focus:outline-none font-mono text-sm" />
          <button onClick={handleDeposit} disabled={loading || !depositTx || !depositAmount} className="w-full py-3 bg-[#00E5A0] hover:bg-[#00cc8e] disabled:opacity-50 text-[#0a0a0a] rounded-lg font-medium transition-colors active:scale-[0.98]">
            {loading ? 'Verifying...' : `Verify ${depositCurrency} Deposit`}
          </button>
        </div>
      </div>

      <div className="bg-[#141414] border border-[#262626] rounded-lg p-6">
        <h2 className="text-lg font-medium mb-4 flex items-center gap-2">
          <ArrowUpFromLine className="w-5 h-5 text-[#a1a1a1]" /> Withdraw
        </h2>
        <div className="space-y-3">
          <div className="flex gap-2">
            {SUPPORTED_CURRENCIES.map((c) => (
              <button
                key={c}
                onClick={() => setWithdrawCurrency(c)}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                  withdrawCurrency === c
                    ? 'border-[#fafafa] bg-[#fafafa]/5 text-[#fafafa]'
                    : 'border-[#262626] text-[#a1a1a1] hover:border-[#333]'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
          <input type="number" step="0.01" placeholder={`Amount (${withdrawCurrency})`} value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)} className="w-full bg-[#141414] border border-[#262626] rounded-lg px-4 py-3 text-[#fafafa] focus:border-[#444] focus:outline-none" />
          <button onClick={handleWithdraw} disabled={loading || !withdrawAmount} className="w-full py-3 border border-[#262626] hover:border-[#333] text-[#a1a1a1] hover:text-[#fafafa] disabled:opacity-50 rounded-lg font-medium transition-colors active:scale-[0.98]">
            {loading ? 'Processing...' : `Withdraw ${withdrawCurrency}`}
          </button>
        </div>
      </div>
    </div>
  );
}

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Wallet, ArrowDownToLine, ArrowUpFromLine, RefreshCw } from 'lucide-react';
import { getBalance, submitDeposit, requestWithdraw } from "@/lib/api";

export default function AccountPage() {
  const [balance, setBalance] = useState<{ balance: number; pending_earnings: number } | null>(null);
  const [depositAmount, setDepositAmount] = useState('');
  const [depositTx, setDepositTx] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [loading, setLoading] = useState(false);

  const fetchBalance = useCallback(async () => {
    try {
      const data = await getBalance();
      setBalance(data);
    } catch { /* not logged in */ }
  }, []);

  useEffect(() => { fetchBalance(); }, [fetchBalance]);

  const formatUSDC = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;

  const handleDeposit = async () => {
    if (!depositTx || !depositAmount) return;
    setLoading(true);
    try {
      await submitDeposit(depositTx, Math.round(parseFloat(depositAmount) * 1_000_000));
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
      await requestWithdraw(Math.round(parseFloat(withdrawAmount) * 1_000_000), '');
      setWithdrawAmount('');
      await fetchBalance();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Withdrawal failed');
    } finally { setLoading(false); }
  };

  return (
    <div className="max-w-2xl mx-auto py-12 px-4">
      <h1 className="text-3xl font-bold mb-8">Account</h1>

      <div className="bg-gradient-to-br from-[#3da8ff]/20 to-[#3da8ff]/20 border border-[#3da8ff]/30 rounded-2xl p-8 mb-8">
        <div className="flex items-center gap-3 mb-4">
          <Wallet className="w-6 h-6 text-[#3da8ff]" />
          <span className="text-[#8b95a8] text-sm font-medium">USDC Balance</span>
          <button onClick={fetchBalance} className="ml-auto text-[#4a5568] hover:text-[#eef1f8]"><RefreshCw className="w-4 h-4" /></button>
        </div>
        <p className="text-5xl font-bold text-[#eef1f8] mb-2">{balance ? formatUSDC(balance.balance) : '\u2014'}</p>
        {balance && balance.pending_earnings > 0 && (
          <p className="text-sm text-[#3da8ff]">+{formatUSDC(balance.pending_earnings)} creator earnings</p>
        )}
      </div>

      <div className="bg-[#0f1117] rounded-xl p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <ArrowDownToLine className="w-5 h-5 text-green-400" /> Deposit USDC
        </h2>
        <p className="text-sm text-[#8b95a8] mb-4">Send USDC to the platform escrow wallet on Solana, then paste the transaction signature below.</p>
        <div className="space-y-3">
          <input type="number" step="0.01" placeholder="Amount (USDC)" value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} className="w-full bg-[#161822] border border-[#1e2a3a] rounded-xl px-4 py-3 text-[#eef1f8] focus:border-[#3da8ff] focus:outline-none" />
          <input type="text" placeholder="Transaction signature" value={depositTx} onChange={(e) => setDepositTx(e.target.value)} className="w-full bg-[#161822] border border-[#1e2a3a] rounded-xl px-4 py-3 text-[#eef1f8] focus:border-[#3da8ff] focus:outline-none font-mono text-sm" />
          <button onClick={handleDeposit} disabled={loading || !depositTx || !depositAmount} className="w-full py-3 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-[#eef1f8] rounded-xl font-medium transition-colors">
            {loading ? 'Verifying...' : 'Verify Deposit'}
          </button>
        </div>
      </div>

      <div className="bg-[#0f1117] rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <ArrowUpFromLine className="w-5 h-5 text-orange-400" /> Withdraw USDC
        </h2>
        <div className="space-y-3">
          <input type="number" step="0.01" placeholder="Amount (USDC)" value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)} className="w-full bg-[#161822] border border-[#1e2a3a] rounded-xl px-4 py-3 text-[#eef1f8] focus:border-[#3da8ff] focus:outline-none" />
          <button onClick={handleWithdraw} disabled={loading || !withdrawAmount} className="w-full py-3 bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-[#eef1f8] rounded-xl font-medium transition-colors">
            {loading ? 'Processing...' : 'Withdraw'}
          </button>
        </div>
      </div>
    </div>
  );
}

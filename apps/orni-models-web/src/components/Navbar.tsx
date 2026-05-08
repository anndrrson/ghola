"use client";

import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useAuth } from "@/lib/wallet-provider";
import { useEffect, useState } from "react";
import { getBalance } from "@/lib/api";
import { Menu, X } from "lucide-react";
import KinakutaLogo from "@/components/KinakutaLogo";

export default function Navbar() {
  const { connected } = useWallet();
  const { authenticated, isCreator } = useAuth();
  const [balance, setBalance] = useState<number | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (authenticated) {
      getBalance()
        // Sum across stablecoins — both USDT and USDC are 1:1 USD pegged.
        .then((b) => setBalance(b.balances.reduce((s, x) => s + x.balance, 0)))
        .catch(() => setBalance(null));
    } else {
      setBalance(null);
    }
  }, [authenticated]);

  return (
    <nav className="sticky top-0 z-50 border-b border-[#262626] bg-[#0a0a0a]/80 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4">
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2.5 text-lg font-medium">
            <KinakutaLogo size={28} className="text-[#fafafa]" />
            <span className="text-[#fafafa] font-medium">
              kinakuta
            </span>
          </Link>
          <div className="hidden items-center gap-6 md:flex">
            <Link
              href="/models"
              className="text-sm text-[#a1a1a1] transition-colors hover:text-[#fafafa]"
            >
              Browse
            </Link>
            {isCreator && (
              <Link
                href="/creator"
                className="text-sm text-[#a1a1a1] transition-colors hover:text-[#fafafa]"
              >
                Creator
              </Link>
            )}
          </div>
        </div>
        <div className="hidden items-center gap-4 md:flex">
          {authenticated && balance !== null && (
            <Link
              href="/account"
              className="rounded-lg bg-[#141414] border border-[#262626] px-3 py-1.5 text-sm font-mono font-medium text-[#00E5A0] transition-colors hover:border-[#333]"
            >
              ${balance.toFixed(2)}
            </Link>
          )}
          <WalletMultiButton />
        </div>
        <button
          className="md:hidden text-[#a1a1a1]"
          onClick={() => setMobileOpen(!mobileOpen)}
        >
          {mobileOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
        </button>
      </div>
      {mobileOpen && (
        <div className="border-t border-[#262626] bg-[#0a0a0a] px-4 py-4 md:hidden">
          <div className="flex flex-col gap-4">
            <Link href="/models" className="text-sm text-[#a1a1a1]" onClick={() => setMobileOpen(false)}>
              Browse
            </Link>
            {isCreator && (
              <Link href="/creator" className="text-sm text-[#a1a1a1]" onClick={() => setMobileOpen(false)}>
                Creator
              </Link>
            )}
            {authenticated && balance !== null && (
              <Link href="/account" className="text-sm text-[#00E5A0] font-mono" onClick={() => setMobileOpen(false)}>
                Balance: ${balance.toFixed(2)}
              </Link>
            )}
            <WalletMultiButton />
          </div>
        </div>
      )}
    </nav>
  );
}

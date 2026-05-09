"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth-context";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { useWalletAuth } from "@/lib/wallet-provider";
import { useTurnkeyWallet } from "@/lib/turnkey-provider";
import { getBalance } from "@/lib/api";
import { GholaLogo } from "@/components/GholaLogo";
import { Menu, X } from "lucide-react";

// Top-nav items: kept to 4 always-visible product surfaces. Per-section
// pages (Provide, Bounties, Marketplace, Developers, Settings, Chat) still
// have their routes — they're reached from contextual links inside Models,
// Earn, or the user menu. The old top nav had 10 items; this is the
// "simplify down" pass.
const NAV_ITEMS = [
  { href: "/models",   label: "Models",   match: "/models"   },
  { href: "/agents",   label: "Agents",   match: "/agents"   },
  { href: "/earn",     label: "Earn",     match: "/earn"     },
  { href: "/identity/login", label: "Identity", match: "/identity" },
] as const;

function truncateAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

export function Navbar() {
  const { authenticated, loading, user, logout } = useAuth();
  const thumperAuth = useThumperAuth();
  const walletAuth = useWalletAuth();
  const { walletAddress } = useTurnkeyWallet();
  const router = useRouter();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    if (walletAuth.authenticated) {
      getBalance()
        // Sum stablecoins (USDT + USDC are both 1:1 USD).
        .then((b) =>
          setBalance(
            "balances" in b
              // New shape from the post-Tether API.
              ? (b as { balances: { balance: number }[] }).balances.reduce(
                  (s, x) => s + x.balance,
                  0,
                )
              // Old shape, in case this hits a not-yet-redeployed instance.
              : (b as unknown as { balance: number }).balance,
          ),
        )
        .catch(() => setBalance(null));
    } else {
      setBalance(null);
    }
  }, [walletAuth.authenticated]);

  const isActive = (match: string) => pathname.startsWith(match);

  function handleLogout() {
    logout();
    setMobileOpen(false);
    setAccountOpen(false);
    router.push("/");
  }

  function handleThumperLogout() {
    thumperAuth.logout();
    setMobileOpen(false);
    setAccountOpen(false);
    router.push("/");
  }

  // One unified auth area replaces the old per-section conditional blocks.
  // Logic: if you have a wallet OR an account, show a compact identity pill;
  // otherwise show a single Sign In / Get Started pair.
  const isAuthed = authenticated || thumperAuth.authenticated || walletAuth.authenticated;

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-[#08090d]/80 backdrop-blur-md border-b border-[#1e2a3a]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          {/* Logo + nav items */}
          <div className="flex items-center gap-8">
            <Link href="/" className="flex items-center gap-1.5">
              <GholaLogo size={28} className="text-[#eef1f8]" />
              <span className="text-xl font-bold tracking-tight text-[#eef1f8]">
                ghola
              </span>
            </Link>
            <div className="hidden sm:flex items-center gap-1">
              {NAV_ITEMS.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    isActive(item.match)
                      ? "bg-[#3da8ff]/10 text-[#3da8ff]"
                      : "text-[#8b95a8] hover:text-[#eef1f8]"
                  }`}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </div>

          {/* Desktop auth area — one block, no per-section variants */}
          <div className="hidden sm:flex items-center gap-3">
            {/* Balance pill, when a wallet is connected */}
            {walletAuth.authenticated && balance !== null && (
              <Link
                href="/vault"
                className="rounded-lg bg-[#161822] px-3 py-1.5 text-sm font-mono text-[#8b95a8] transition hover:bg-[#1c1f2e]"
                title="Vault"
              >
                ${(balance / 1_000_000).toFixed(2)}
              </Link>
            )}

            {/* Vault is the account hub — always reachable when authed */}
            {isAuthed && (
              <Link
                href="/vault"
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  pathname.startsWith("/vault")
                    ? "bg-[#3da8ff]/10 text-[#3da8ff]"
                    : "text-[#8b95a8] hover:text-[#eef1f8]"
                }`}
              >
                Vault
              </Link>
            )}

            {/* Account menu: collapses Chat / Settings / Developers / Identity Dashboard / Sign Out */}
            {isAuthed ? (
              <div className="relative">
                <button
                  onClick={() => setAccountOpen((v) => !v)}
                  className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] transition-colors cursor-pointer"
                >
                  {walletAddress ? (
                    <span className="font-mono">{truncateAddress(walletAddress)}</span>
                  ) : (
                    <span>Account</span>
                  )}
                  <span className="text-[#4a5568]">▾</span>
                </button>
                {accountOpen && (
                  <div className="absolute right-0 mt-2 w-56 rounded-lg border border-[#1e2a3a] bg-[#0f1117] py-1 shadow-xl">
                    {(authenticated || thumperAuth.authenticated) && (
                      <p className="border-b border-[#1e2a3a] px-3 py-2 text-xs text-[#4a5568]">
                        {user?.email || thumperAuth.user?.email}
                      </p>
                    )}
                    {thumperAuth.authenticated && (
                      <>
                        <Link
                          href="/chat"
                          onClick={() => setAccountOpen(false)}
                          className="block px-3 py-2 text-sm text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#161822]"
                        >
                          Chat
                        </Link>
                        <Link
                          href="/settings"
                          onClick={() => setAccountOpen(false)}
                          className="block px-3 py-2 text-sm text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#161822]"
                        >
                          Settings
                        </Link>
                        <Link
                          href="/developers"
                          onClick={() => setAccountOpen(false)}
                          className="block px-3 py-2 text-sm text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#161822]"
                        >
                          Developers
                        </Link>
                      </>
                    )}
                    {authenticated && (
                      <Link
                        href="/identity/dashboard"
                        onClick={() => setAccountOpen(false)}
                        className="block px-3 py-2 text-sm text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#161822]"
                      >
                        Identity Dashboard
                      </Link>
                    )}
                    <div className="border-t border-[#1e2a3a] mt-1 pt-1">
                      <button
                        onClick={authenticated ? handleLogout : handleThumperLogout}
                        className="block w-full px-3 py-2 text-left text-sm text-[#4a5568] hover:text-[#eef1f8] hover:bg-[#161822] cursor-pointer"
                      >
                        Sign Out
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : loading ? (
              <div className="h-8 w-24 animate-pulse rounded bg-[#161822]" />
            ) : (
              <>
                <Link
                  href="/signin"
                  className="whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] transition-colors"
                >
                  Sign In
                </Link>
                <Link
                  href="/signup"
                  className="whitespace-nowrap rounded-md bg-[#3da8ff] px-4 py-2 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors"
                >
                  Get Started
                </Link>
              </>
            )}
          </div>

          {/* Mobile hamburger */}
          <button
            className="sm:hidden p-2 text-[#8b95a8] hover:text-[#eef1f8] cursor-pointer"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label="Toggle menu"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* Mobile menu — same 4 nav items, then auth */}
      {mobileOpen && (
        <div className="sm:hidden border-t border-[#1e2a3a] bg-[#08090d]/95 backdrop-blur-md">
          <div className="px-4 py-4 space-y-1">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={`block rounded-md px-3 py-2 text-sm font-medium ${
                  isActive(item.match)
                    ? "bg-[#3da8ff]/10 text-[#3da8ff]"
                    : "text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#0f1117]"
                }`}
              >
                {item.label}
              </Link>
            ))}
            <Link
              href="/vault"
              onClick={() => setMobileOpen(false)}
              className="block rounded-md px-3 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#0f1117]"
            >
              Vault
              {walletAuth.authenticated && balance !== null && (
                <span className="ml-2 font-mono text-xs text-[#4a5568]">
                  ${(balance / 1_000_000).toFixed(2)}
                </span>
              )}
            </Link>

            <div className="border-t border-[#1e2a3a] pt-2 mt-2 space-y-1">
              {thumperAuth.authenticated && (
                <>
                  <Link
                    href="/chat"
                    onClick={() => setMobileOpen(false)}
                    className="block rounded-md px-3 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#0f1117]"
                  >
                    Chat
                  </Link>
                  <Link
                    href="/settings"
                    onClick={() => setMobileOpen(false)}
                    className="block rounded-md px-3 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#0f1117]"
                  >
                    Settings
                  </Link>
                  <Link
                    href="/developers"
                    onClick={() => setMobileOpen(false)}
                    className="block rounded-md px-3 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#0f1117]"
                  >
                    Developers
                  </Link>
                </>
              )}
              {authenticated && (
                <Link
                  href="/identity/dashboard"
                  onClick={() => setMobileOpen(false)}
                  className="block rounded-md px-3 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#0f1117]"
                >
                  Identity Dashboard
                </Link>
              )}
              {isAuthed ? (
                <>
                  <p className="px-3 py-2 text-xs text-[#4a5568]">
                    {user?.email || thumperAuth.user?.email}
                    {walletAddress && (
                      <span className="ml-2 font-mono">
                        ({truncateAddress(walletAddress)})
                      </span>
                    )}
                  </p>
                  <button
                    onClick={authenticated ? handleLogout : handleThumperLogout}
                    className="block w-full text-left rounded-md px-3 py-2 text-sm font-medium text-[#4a5568] hover:text-[#eef1f8] hover:bg-[#0f1117] cursor-pointer"
                  >
                    Sign Out
                  </button>
                </>
              ) : (
                <>
                  <Link
                    href="/signin"
                    onClick={() => setMobileOpen(false)}
                    className="block rounded-md px-3 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#0f1117]"
                  >
                    Sign In
                  </Link>
                  <Link
                    href="/signup"
                    onClick={() => setMobileOpen(false)}
                    className="block rounded-md bg-[#3da8ff] px-3 py-2 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff]"
                  >
                    Get Started
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}

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
import { Menu, ShieldCheck, X } from "lucide-react";
import { AuthModal, type AuthMode } from "@/components/AuthModal";

// Consumer-altitude framing: the public site is a chat product. No
// product-surface links in the top nav for logged-out visitors —
// just Sign In / Get Started. Pages like /security, /network,
// /developers, /agents, /models, /marketplace, /provide, /bounties,
// /earn all still exist at their URLs and are reachable by direct
// link (and indexed for SEO), but they're not surfaced from the
// public chrome. Anyone who needs them gets the link from us.
//
// Logged-in users get Chat + Vault + an Account dropdown that
// collapses the secondary surfaces (Agents, Settings, Developers,
// Identity Dashboard, Sign Out).
const NAV_ITEMS: ReadonlyArray<{ href: string; label: string; match: string }> = [];

function truncateAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

export function Navbar() {
  const { authenticated, user, logout } = useAuth();
  const thumperAuth = useThumperAuth();
  const walletAuth = useWalletAuth();
  const { walletAddress } = useTurnkeyWallet();
  const router = useRouter();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("signup");
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

  function openAuth(mode: AuthMode) {
    setAuthMode(mode);
    setAuthOpen(true);
    setMobileOpen(false);
    setAccountOpen(false);
  }

  // One unified auth area replaces the old per-section conditional blocks.
  // Logic: if you have a wallet OR an account, show a compact identity pill;
  // otherwise show a single Sign In / Get Started pair.
  const isAuthed = authenticated || thumperAuth.authenticated || walletAuth.authenticated;

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-[#08090d] border-b border-[#1e2a3a]">
      <AuthModal
        mode={authMode}
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onModeChange={setAuthMode}
      />
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
              <>
                <Link
                  href="/private-balance"
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    pathname.startsWith("/private-balance")
                      ? "bg-[#3da8ff]/10 text-[#3da8ff]"
                      : "text-[#8b95a8] hover:text-[#eef1f8]"
                  }`}
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Private
                </Link>
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
              </>
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
                          href="/intent"
                          onClick={() => setAccountOpen(false)}
                          className="block px-3 py-2 text-sm text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#161822]"
                        >
                          Shop / Pay
                        </Link>
                        <Link
                          href="/strategies"
                          onClick={() => setAccountOpen(false)}
                          className="block px-3 py-2 text-sm text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#161822]"
                        >
                          Strategies
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
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => openAuth("signin")}
                  className="whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium text-[#8b95a8] transition-colors hover:text-[#eef1f8]"
                >
                  Sign In
                </button>
                <button
                  type="button"
                  onClick={() => openAuth("signup")}
                  className="whitespace-nowrap rounded-md bg-[#3da8ff] px-4 py-2 text-sm font-medium text-[#08090d] transition-colors hover:bg-[#5bb8ff]"
                >
                  Get Started
                </button>
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
        <div className="sm:hidden border-t border-[#1e2a3a] bg-[#08090d]">
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
              href="/private-balance"
              onClick={() => setMobileOpen(false)}
              className="block rounded-md px-3 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#0f1117]"
            >
              Private Balance
            </Link>
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
                    href="/intent"
                    onClick={() => setMobileOpen(false)}
                    className="block rounded-md px-3 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#0f1117]"
                  >
                    Shop / Pay
                  </Link>
                  <Link
                    href="/strategies"
                    onClick={() => setMobileOpen(false)}
                    className="block rounded-md px-3 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#0f1117]"
                  >
                    Strategies
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
                  <button
                    type="button"
                    onClick={() => openAuth("signin")}
                    className="block w-full rounded-md px-3 py-2 text-left text-sm font-medium text-[#8b95a8] hover:bg-[#0f1117] hover:text-[#eef1f8]"
                  >
                    Sign In
                  </button>
                  <button
                    type="button"
                    onClick={() => openAuth("signup")}
                    className="block w-full rounded-md bg-[#3da8ff] px-3 py-2 text-left text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff]"
                  >
                    Get Started
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}

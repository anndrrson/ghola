"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useState } from "react";
import dynamic from "next/dynamic";
import { useAuth } from "@/lib/auth-context";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import { useWalletAuth } from "@/lib/wallet-provider";
import { useTurnkeyWallet } from "@/lib/turnkey-provider";
import { GholaLogo } from "@/components/GholaLogo";
import { Menu, X } from "lucide-react";
import type { AuthMode } from "@/components/AuthModal";

const AuthModal = dynamic(
  () => import("@/components/AuthModal").then((mod) => mod.AuthModal),
  { ssr: false, loading: () => null },
);

const NAV_ITEMS: ReadonlyArray<{ href: string; label: string; match: string }> = [
  { href: "/trade", label: "Live trading", match: "/trade" },
  { href: "/carry", label: "Carry", match: "/carry" },
  { href: "/trade?product=automate", label: "Automate", match: "/never-active" },
];

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

  const isActive = (match: string) => pathname.startsWith(match);
  const terminalRoute = pathname.startsWith("/account") || pathname.startsWith("/app/account");

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
    <nav className="fixed inset-x-0 top-0 z-50 border-b border-[#272a31] bg-[#08090b]/95 backdrop-blur-xl">
      {authOpen && (
        <AuthModal
          mode={authMode}
          open={authOpen}
          onClose={() => setAuthOpen(false)}
          onModeChange={setAuthMode}
          redirectTo="/trade"
        />
      )}
      <div className={terminalRoute ? "px-4 sm:px-6 lg:px-8" : "mx-auto max-w-[1480px] px-4 sm:px-6 lg:px-8"}>
        <div className="flex h-16 items-center justify-between">
          {/* Logo + nav items */}
          <div className="flex min-w-0 items-center gap-7">
            <Link href="/" className="flex items-center gap-2.5 rounded-md text-[#d9dde4] transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40">
              <GholaLogo size={24} className="text-[#3da8ff]" />
              <span className="text-[18px] font-semibold tracking-[-0.025em] text-current">
                ghola
              </span>
            </Link>
            <div className="hidden items-center gap-1.5 sm:flex">
              {NAV_ITEMS.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                    isActive(item.match)
                      ? "border-white/10 bg-white/[0.06] text-[#eceef2]"
                      : "border-transparent text-[#8f95a1] hover:bg-white/[0.035] hover:text-[#d9dde4]"
                  }`}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </div>

          {terminalRoute && (
            <div className="hidden min-w-0 flex-1 items-center justify-center gap-2 px-4 lg:flex">
              <TerminalStatusPill label="Market" value="live" tone="good" />
              <TerminalStatusPill label="No-key live" value="Phoenix" tone="good" />
              <TerminalStatusPill label="Worker" value="off" tone="warn" />
              <TerminalStatusPill label="Pooled" value="off" tone="warn" />
            </div>
          )}

          {/* Desktop auth area — one block, no per-section variants */}
          <div className="hidden shrink-0 items-center gap-3 sm:flex">
            <BetaBadge />
            {/* Account menu: collapses Chat / Settings / Developers / Identity Dashboard / Sign Out */}
            {isAuthed && terminalRoute ? (
              <>
                <Link
                  href="/private-balance"
                  className="rounded-md border border-[#1e2a3a] bg-[#0f1117] px-4 py-2 text-sm font-medium text-[#8b95a8] transition-colors hover:text-[#eef1f8]"
                >
                  Balance
                </Link>
                <button
                  type="button"
                  onClick={() => setAccountOpen((v) => !v)}
                  className="rounded-md bg-[#0f1624] px-4 py-2 text-sm font-medium text-[#a8d8ff] transition-colors hover:text-[#eef1f8]"
                >
                  {user?.email || thumperAuth.user?.email || (walletAddress ? truncateAddress(walletAddress) : "Account")}
                </button>
                {accountOpen && (
                  <div className="absolute right-4 top-14 w-56 rounded-lg border border-[#1e2a3a] bg-[#0f1117] py-1 shadow-xl">
                    {(authenticated || thumperAuth.authenticated) && (
                      <p className="border-b border-[#1e2a3a] px-3 py-2 text-xs text-[#4a5568]">
                        {user?.email || thumperAuth.user?.email}
                      </p>
                    )}
                    <Link
                      href="/settings"
                      onClick={() => setAccountOpen(false)}
                      className="block px-3 py-2 text-sm text-[#8b95a8] hover:bg-[#161822] hover:text-[#eef1f8]"
                    >
                      Settings
                    </Link>
                    <button
                      onClick={authenticated ? handleLogout : handleThumperLogout}
                      className="block w-full px-3 py-2 text-left text-sm text-[#4a5568] hover:bg-[#161822] hover:text-[#eef1f8]"
                    >
                      Sign Out
                    </button>
                  </div>
                )}
              </>
            ) : isAuthed ? (
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
          <div className="flex items-center gap-2 sm:hidden">
            <BetaBadge compact />
            <button
              className="p-2 text-[#8b95a8] hover:text-[#eef1f8] cursor-pointer"
              onClick={() => setMobileOpen(!mobileOpen)}
              aria-label="Toggle menu"
            >
              {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile menu */}
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
                    ? "bg-white/[0.06] text-[#eceef2]"
                    : "text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#0f1117]"
                }`}
              >
                {item.label}
              </Link>
            ))}

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

function BetaBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span
      aria-label="Ghola beta capped rollout"
      className="inline-flex h-8 shrink-0 items-center gap-2 rounded-full border border-amber-300/35 bg-amber-300/10 px-3 text-[11px] font-semibold uppercase text-amber-100 shadow-[0_0_18px_-10px_rgba(251,191,36,0.9)]"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
      <span>Beta</span>
      {!compact && (
        <span className="font-mono text-[10px] font-medium normal-case text-amber-100/70">
          capped rollout
        </span>
      )}
    </span>
  );
}

function TerminalStatusPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "good" | "warn";
}) {
  const toneClass = tone === "good"
    ? "border-emerald-300/30 bg-emerald-300/10 text-emerald-100 shadow-[0_0_18px_-8px_rgba(110,231,183,0.75)]"
    : "border-yellow-300/35 bg-yellow-300/10 text-yellow-100 shadow-[0_0_18px_-8px_rgba(250,204,21,0.75)]";
  const dotClass = tone === "good" ? "bg-emerald-300" : "bg-yellow-300";
  return (
    <span className={`inline-flex h-8 items-center gap-2 rounded-full border px-3 text-sm ${toneClass}`}>
      <span className={`h-2 w-2 rounded-full ${dotClass}`} />
      <span className="text-[#8b95a8]">{label}</span>
      <span className="font-medium">{value}</span>
    </span>
  );
}

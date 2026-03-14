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

type Section = "home" | "identity" | "models" | "chat" | "settings" | "vault";

function getSection(pathname: string): Section {
  if (pathname.startsWith("/identity")) return "identity";
  if (pathname.startsWith("/models")) return "models";
  if (pathname.startsWith("/chat")) return "chat";
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname.startsWith("/vault")) return "vault";
  return "home";
}

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
  const section = getSection(pathname);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    if (walletAuth.authenticated) {
      getBalance()
        .then((b) => setBalance(b.balance))
        .catch(() => setBalance(null));
    } else {
      setBalance(null);
    }
  }, [walletAuth.authenticated]);

  function handleLogout() {
    logout();
    setMobileOpen(false);
    router.push("/");
  }

  function handleThumperLogout() {
    thumperAuth.logout();
    setMobileOpen(false);
    router.push("/");
  }

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-[#08090d]/80 backdrop-blur-md border-b border-[#1e2a3a]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          {/* Logo + Section Tabs */}
          <div className="flex items-center gap-8">
            <Link href="/" className="flex items-center gap-2.5">
              <GholaLogo size={28} className="text-[#eef1f8]" />
              <span className="text-xl font-bold tracking-tight text-[#eef1f8]">
                ghola
              </span>
            </Link>
            <div className="hidden sm:flex items-center gap-1">
              {thumperAuth.authenticated && (
                <Link
                  href="/chat"
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    section === "chat"
                      ? "bg-[#3da8ff]/10 text-[#3da8ff]"
                      : "text-[#8b95a8] hover:text-[#eef1f8]"
                  }`}
                >
                  Chat
                </Link>
              )}
              {thumperAuth.authenticated && (
                <Link
                  href="/settings"
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    section === "settings"
                      ? "bg-[#3da8ff]/10 text-[#3da8ff]"
                      : "text-[#8b95a8] hover:text-[#eef1f8]"
                  }`}
                >
                  Settings
                </Link>
              )}
              <Link
                href="/vault"
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  section === "vault"
                    ? "bg-[#3da8ff]/10 text-[#3da8ff]"
                    : "text-[#8b95a8] hover:text-[#eef1f8]"
                }`}
              >
                Vault
              </Link>
              <Link
                href="/identity/login"
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  section === "identity"
                    ? "bg-[#3da8ff]/10 text-[#3da8ff]"
                    : "text-[#8b95a8] hover:text-[#eef1f8]"
                }`}
              >
                Identity
              </Link>
              <Link
                href="/models"
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  section === "models"
                    ? "bg-[#3da8ff]/10 text-[#3da8ff]"
                    : "text-[#8b95a8] hover:text-[#eef1f8]"
                }`}
              >
                Models
              </Link>
            </div>
          </div>

          {/* Desktop auth area */}
          <div className="hidden sm:flex items-center gap-4">
            {walletAddress && thumperAuth.authenticated && (
              <Link
                href="/models"
                className="rounded-lg bg-[#161822] px-3 py-1.5 text-sm font-mono text-[#8b95a8] transition hover:bg-[#1c1f2e]"
              >
                {truncateAddress(walletAddress)}
              </Link>
            )}
            {section === "identity" && (
              <>
                {loading ? (
                  <div className="h-5 w-24 animate-pulse rounded bg-[#161822]" />
                ) : authenticated ? (
                  <>
                    <span className="text-sm text-[#8b95a8]">{user?.email}</span>
                    <Link
                      href="/identity/dashboard"
                      className="rounded-md px-3 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] transition-colors"
                    >
                      Dashboard
                    </Link>
                    <button
                      onClick={handleLogout}
                      className="rounded-md px-3 py-2 text-sm font-medium text-[#4a5568] hover:text-[#eef1f8] transition-colors cursor-pointer"
                    >
                      Log Out
                    </button>
                  </>
                ) : (
                  <>
                    <Link
                      href="/identity/login"
                      className="rounded-md px-3 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] transition-colors"
                    >
                      Log In
                    </Link>
                    <Link
                      href="/identity/register"
                      className="rounded-md bg-[#3da8ff] px-4 py-2 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors"
                    >
                      Get Started
                    </Link>
                  </>
                )}
              </>
            )}
            {section === "models" && (
              <>
                <Link
                  href="/models/nodes"
                  className="text-sm text-[#8b95a8] transition hover:text-[#eef1f8]"
                >
                  Nodes
                </Link>
                {walletAuth.authenticated && walletAuth.isCreator && (
                  <Link
                    href="/models/creator"
                    className="text-sm text-[#8b95a8] transition hover:text-[#eef1f8]"
                  >
                    Creator
                  </Link>
                )}
                {walletAuth.authenticated && balance !== null && (
                  <Link
                    href="/models/account"
                    className="rounded-lg bg-[#161822] px-3 py-1.5 text-sm font-medium text-[#8b95a8] transition hover:bg-[#1c1f2e]"
                  >
                    ${(balance / 1_000_000).toFixed(2)}
                  </Link>
                )}
                {!walletAddress && !thumperAuth.authenticated && (
                  <Link
                    href="/signin"
                    className="rounded-md bg-[#3da8ff] px-4 py-2 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors"
                  >
                    Sign in
                  </Link>
                )}
              </>
            )}
            {(section === "home" || section === "vault") && (
              <>
                {thumperAuth.authenticated ? (
                  <>
                    <Link
                      href="/chat"
                      className="rounded-md px-3 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] transition-colors"
                    >
                      Chat
                    </Link>
                    <button
                      onClick={handleThumperLogout}
                      className="rounded-md px-3 py-2 text-sm font-medium text-[#4a5568] hover:text-[#eef1f8] transition-colors cursor-pointer"
                    >
                      Log Out
                    </button>
                  </>
                ) : (
                  <>
                    <Link
                      href="/signin"
                      className="rounded-md px-3 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] transition-colors"
                    >
                      Sign In
                    </Link>
                    <Link
                      href="/signup"
                      className="rounded-md bg-[#3da8ff] px-4 py-2 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff] transition-colors"
                    >
                      Get Started
                    </Link>
                  </>
                )}
              </>
            )}
            {section === "settings" && thumperAuth.authenticated && (
              <>
                <span className="text-sm text-[#8b95a8]">{thumperAuth.user?.email}</span>
                <Link
                  href="/chat"
                  className="rounded-md px-3 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] transition-colors"
                >
                  Chat
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

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="sm:hidden border-t border-[#1e2a3a] bg-[#08090d]/95 backdrop-blur-md">
          <div className="px-4 py-4 space-y-2">
            {thumperAuth.authenticated && (
              <Link
                href="/chat"
                onClick={() => setMobileOpen(false)}
                className="block rounded-md px-3 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#0f1117]"
              >
                Chat
              </Link>
            )}
            {thumperAuth.authenticated && (
              <Link
                href="/settings"
                onClick={() => setMobileOpen(false)}
                className="block rounded-md px-3 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#0f1117]"
              >
                Settings
              </Link>
            )}
            <Link
              href="/vault"
              onClick={() => setMobileOpen(false)}
              className="block rounded-md px-3 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#0f1117]"
            >
              Vault
            </Link>
            <Link
              href="/identity/login"
              onClick={() => setMobileOpen(false)}
              className="block rounded-md px-3 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#0f1117]"
            >
              Identity
            </Link>
            <Link
              href="/models"
              onClick={() => setMobileOpen(false)}
              className="block rounded-md px-3 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#0f1117]"
            >
              Models
            </Link>
            <div className="border-t border-[#1e2a3a] pt-2 mt-2">
              {thumperAuth.authenticated ? (
                <>
                  <p className="px-3 py-2 text-sm text-[#4a5568]">{thumperAuth.user?.email}</p>
                  <button
                    onClick={handleThumperLogout}
                    className="block w-full text-left rounded-md px-3 py-2 text-sm font-medium text-[#4a5568] hover:text-[#eef1f8] hover:bg-[#0f1117] cursor-pointer"
                  >
                    Log Out
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
              {walletAddress && (
                <p className="mt-2 px-3 py-1 text-xs font-mono text-[#4a5568]">
                  {truncateAddress(walletAddress)}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}

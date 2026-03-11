"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth-context";
import { useWalletAuth } from "@/lib/wallet-provider";
import { getBalance } from "@/lib/api";
import { Bot, Menu, X } from "lucide-react";
import dynamic from "next/dynamic";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false }
);

type Section = "home" | "identity" | "models";

function getSection(pathname: string): Section {
  if (pathname.startsWith("/identity")) return "identity";
  if (pathname.startsWith("/models")) return "models";
  return "home";
}

export function Navbar() {
  const { authenticated, loading, user, logout } = useAuth();
  const walletAuth = useWalletAuth();
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

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-gray-900/80 backdrop-blur-md border-b border-gray-800">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          {/* Logo + Section Tabs */}
          <div className="flex items-center gap-8">
            <Link href="/" className="flex items-center gap-2">
              <Bot className="h-6 w-6 text-coral-400" />
              <span className="text-xl font-bold tracking-tight text-white">
                kinakuta
              </span>
            </Link>
            <div className="hidden sm:flex items-center gap-1">
              <Link
                href="/identity/login"
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  section === "identity"
                    ? "bg-said-500/10 text-said-400"
                    : "text-gray-400 hover:text-white"
                }`}
              >
                Identity
              </Link>
              <Link
                href="/models"
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  section === "models"
                    ? "bg-coral-500/10 text-coral-400"
                    : "text-gray-400 hover:text-white"
                }`}
              >
                Models
              </Link>
            </div>
          </div>

          {/* Desktop auth area */}
          <div className="hidden sm:flex items-center gap-4">
            {section === "identity" && (
              <>
                {loading ? (
                  <div className="h-5 w-24 animate-pulse rounded bg-gray-800" />
                ) : authenticated ? (
                  <>
                    <span className="text-sm text-gray-400">{user?.email}</span>
                    <Link
                      href="/identity/dashboard"
                      className="rounded-md px-3 py-2 text-sm font-medium text-gray-300 hover:text-white transition-colors"
                    >
                      Dashboard
                    </Link>
                    <button
                      onClick={handleLogout}
                      className="rounded-md px-3 py-2 text-sm font-medium text-gray-400 hover:text-white transition-colors cursor-pointer"
                    >
                      Log Out
                    </button>
                  </>
                ) : (
                  <>
                    <Link
                      href="/identity/login"
                      className="rounded-md px-3 py-2 text-sm font-medium text-gray-300 hover:text-white transition-colors"
                    >
                      Log In
                    </Link>
                    <Link
                      href="/identity/register"
                      className="rounded-md bg-said-500 px-4 py-2 text-sm font-medium text-white hover:bg-said-600 transition-colors"
                    >
                      Get Started
                    </Link>
                  </>
                )}
              </>
            )}
            {section === "models" && (
              <>
                {walletAuth.authenticated && walletAuth.isCreator && (
                  <Link
                    href="/models/creator"
                    className="text-sm text-gray-400 transition hover:text-white"
                  >
                    Creator
                  </Link>
                )}
                {walletAuth.authenticated && balance !== null && (
                  <Link
                    href="/models/account"
                    className="rounded-lg bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-300 transition hover:bg-gray-700"
                  >
                    ${(balance / 1_000_000).toFixed(2)}
                  </Link>
                )}
                <WalletMultiButton />
              </>
            )}
            {section === "home" && (
              <>
                {authenticated ? (
                  <>
                    <Link
                      href="/identity/dashboard"
                      className="rounded-md px-3 py-2 text-sm font-medium text-gray-300 hover:text-white transition-colors"
                    >
                      Dashboard
                    </Link>
                    <button
                      onClick={handleLogout}
                      className="rounded-md px-3 py-2 text-sm font-medium text-gray-400 hover:text-white transition-colors cursor-pointer"
                    >
                      Log Out
                    </button>
                  </>
                ) : (
                  <Link
                    href="/identity/login"
                    className="rounded-md px-3 py-2 text-sm font-medium text-gray-300 hover:text-white transition-colors"
                  >
                    Log In
                  </Link>
                )}
                <WalletMultiButton />
              </>
            )}
          </div>

          {/* Mobile hamburger */}
          <button
            className="sm:hidden p-2 text-gray-400 hover:text-white cursor-pointer"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label="Toggle menu"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="sm:hidden border-t border-gray-800 bg-gray-900/95 backdrop-blur-md">
          <div className="px-4 py-4 space-y-2">
            <Link
              href="/identity/login"
              onClick={() => setMobileOpen(false)}
              className="block rounded-md px-3 py-2 text-sm font-medium text-gray-300 hover:text-white hover:bg-gray-800"
            >
              Identity
            </Link>
            <Link
              href="/models"
              onClick={() => setMobileOpen(false)}
              className="block rounded-md px-3 py-2 text-sm font-medium text-gray-300 hover:text-white hover:bg-gray-800"
            >
              Models
            </Link>
            <div className="border-t border-gray-800 pt-2 mt-2">
              {authenticated ? (
                <>
                  <p className="px-3 py-2 text-sm text-gray-400">{user?.email}</p>
                  <Link
                    href="/identity/dashboard"
                    onClick={() => setMobileOpen(false)}
                    className="block rounded-md px-3 py-2 text-sm font-medium text-gray-300 hover:text-white hover:bg-gray-800"
                  >
                    Dashboard
                  </Link>
                  <button
                    onClick={handleLogout}
                    className="block w-full text-left rounded-md px-3 py-2 text-sm font-medium text-gray-400 hover:text-white hover:bg-gray-800 cursor-pointer"
                  >
                    Log Out
                  </button>
                </>
              ) : (
                <>
                  <Link
                    href="/identity/login"
                    onClick={() => setMobileOpen(false)}
                    className="block rounded-md px-3 py-2 text-sm font-medium text-gray-300 hover:text-white hover:bg-gray-800"
                  >
                    Log In
                  </Link>
                  <Link
                    href="/identity/register"
                    onClick={() => setMobileOpen(false)}
                    className="block rounded-md bg-said-500 px-3 py-2 text-sm font-medium text-white hover:bg-said-600"
                  >
                    Get Started
                  </Link>
                </>
              )}
              <div className="mt-2">
                <WalletMultiButton />
              </div>
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}

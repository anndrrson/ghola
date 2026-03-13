"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth-context";
import { useWalletAuth } from "@/lib/wallet-provider";
import { getBalance } from "@/lib/api";
import { GholaLogo } from "@/components/GholaLogo";
import { Menu, X } from "lucide-react";
import dynamic from "next/dynamic";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false }
);

type Section = "home" | "identity" | "models" | "chat";

function getSection(pathname: string): Section {
  if (pathname.startsWith("/identity")) return "identity";
  if (pathname.startsWith("/models")) return "models";
  if (pathname.startsWith("/chat")) return "chat";
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
            </div>
          </div>

          {/* Desktop auth area */}
          <div className="hidden sm:flex items-center gap-4">
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
                <WalletMultiButton />
              </>
            )}
            {section === "home" && (
              <>
                {authenticated ? (
                  <>
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
                  <Link
                    href="/identity/login"
                    className="rounded-md px-3 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] transition-colors"
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
            <Link
              href="/chat"
              onClick={() => setMobileOpen(false)}
              className="block rounded-md px-3 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#0f1117]"
            >
              Chat
            </Link>
            <div className="border-t border-[#1e2a3a] pt-2 mt-2">
              {authenticated ? (
                <>
                  <p className="px-3 py-2 text-sm text-[#4a5568]">{user?.email}</p>
                  <Link
                    href="/identity/dashboard"
                    onClick={() => setMobileOpen(false)}
                    className="block rounded-md px-3 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#0f1117]"
                  >
                    Dashboard
                  </Link>
                  <button
                    onClick={handleLogout}
                    className="block w-full text-left rounded-md px-3 py-2 text-sm font-medium text-[#4a5568] hover:text-[#eef1f8] hover:bg-[#0f1117] cursor-pointer"
                  >
                    Log Out
                  </button>
                </>
              ) : (
                <>
                  <Link
                    href="/identity/login"
                    onClick={() => setMobileOpen(false)}
                    className="block rounded-md px-3 py-2 text-sm font-medium text-[#8b95a8] hover:text-[#eef1f8] hover:bg-[#0f1117]"
                  >
                    Log In
                  </Link>
                  <Link
                    href="/identity/register"
                    onClick={() => setMobileOpen(false)}
                    className="block rounded-md bg-[#3da8ff] px-3 py-2 text-sm font-medium text-[#08090d] hover:bg-[#5bb8ff]"
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

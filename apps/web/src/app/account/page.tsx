import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { GholaLogo } from "@/components/GholaLogo";
import { HyperliquidAccountSetup } from "@/components/trade/HyperliquidAccountSetup";

export const metadata: Metadata = {
  title: "Hyperliquid setup — Ghola",
  description: "Connect scoped Hyperliquid access for Ghola's private trading terminal.",
};

export default function AccountPage() {
  return (
    <main className="min-h-screen bg-[#05070b] text-[#eef1f8]">
      <header className="border-b border-[#171c25] bg-[#080a0f]">
        <div className="mx-auto flex h-12 max-w-5xl items-center justify-between px-4 sm:px-6">
          <Link href="/trade" aria-label="Ghola trading terminal" className="flex items-center gap-2 text-sm font-semibold">
            <GholaLogo size={18} className="text-[#7fc1ff]" />
            ghola
          </Link>
          <Link href="/trade" className="inline-flex items-center gap-1.5 text-xs text-[#8b95a8] hover:text-[#dce6f4]">
            <ArrowLeft className="h-3.5 w-3.5" /> Trading terminal
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
        <div className="mb-6 max-w-3xl">
          <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#8ec7ff]">
            <ShieldCheck className="h-3.5 w-3.5" /> Scoped venue access
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Connect Hyperliquid</h1>
          <p className="mt-2 text-sm leading-6 text-[#8b95a8]">
            Complete eligibility first, start the attested worker, then seal a trade-only API wallet. Never enter a seed phrase or withdrawal key.
          </p>
        </div>

        <HyperliquidAccountSetup />
      </div>
    </main>
  );
}

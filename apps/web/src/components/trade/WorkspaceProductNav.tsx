"use client";

import Link from "next/link";
import type { TradeProduct } from "@/lib/trading-capabilities";

export const TRADE_PRODUCT_OPTIONS: ReadonlyArray<{ id: TradeProduct; label: string }> = [
  { id: "spot", label: "Spot" },
  { id: "perps", label: "Perps" },
  { id: "swap", label: "Swap" },
  { id: "automate", label: "Automate" },
];

export function WorkspaceProductNav({
  value,
  onChange,
}: {
  value: TradeProduct;
  onChange: (value: TradeProduct) => void;
}) {
  return (
    <nav
      aria-label="Trading workspace"
      className="flex w-full gap-1 overflow-x-auto rounded-lg border border-[#252a32] bg-[#0b0d11] p-1"
    >
      {TRADE_PRODUCT_OPTIONS.map((product) => (
        <button
          key={product.id}
          type="button"
          aria-current={value === product.id ? "page" : undefined}
          onClick={() => onChange(product.id)}
          className={
            value === product.id
              ? "min-w-[88px] flex-1 rounded-md bg-[#142235] px-4 py-2.5 text-sm font-semibold text-[#8fcbff] shadow-[inset_0_0_0_1px_rgba(61,168,255,0.24)]"
              : "min-w-[88px] flex-1 rounded-md px-4 py-2.5 text-sm font-medium text-[#7f8998] transition hover:bg-white/[0.035] hover:text-[#dfe5ed]"
          }
        >
          {product.label}
        </button>
      ))}
      <Link
        href="/carry"
        aria-label="Open cross-venue Carry"
        className="inline-flex min-w-[104px] flex-1 items-center justify-center gap-2 rounded-md border border-[#29445e] bg-[#0d1722] px-4 py-2.5 text-sm font-semibold text-[#8fcbff] transition hover:border-[#3d6b93] hover:bg-[#112033] hover:text-[#c8e7ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8fcbff]/60"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-[#62d6a5]" aria-hidden />
        Carry
      </Link>
    </nav>
  );
}

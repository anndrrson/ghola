/**
 * /m/[slug] — public listing page for a proxy-mode merchant.
 *
 * Server-rendered (React server component) so the URL is shareable and
 * crawlable. Shows the merchant's name, description, price, wallet, total
 * revenue, and a copy-ready `gateway.ghola.xyz/m/{slug}` URL that any x402
 * client can hit immediately.
 *
 * This is intentionally NOT a dashboard — it's the product page a merchant
 * sends to their docs site or Twitter. The dashboard lives at `/dash`.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import type { MerchantPublicListing } from "@/lib/api";

async function fetchListing(slug: string): Promise<MerchantPublicListing | null> {
  const base =
    process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/v1";
  try {
    const res = await fetch(`${base}/m/${encodeURIComponent(slug)}`, {
      // Public listings change slowly. Revalidate every 30s.
      next: { revalidate: 30 },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export default async function MerchantPublicPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const listing = await fetchListing(slug);
  if (!listing) {
    notFound();
  }

  const priceUsd = (listing.price_micro_usdc / 1_000_000).toFixed(
    listing.price_micro_usdc < 1_000 ? 6 : 4,
  );
  const revenueUsd = (listing.total_revenue_micro_usdc / 1_000_000).toFixed(2);

  return (
    <div className="min-h-screen bg-black text-[#eef1f8] font-[family-name:var(--font-geist-sans)]">
      <div className="mx-auto max-w-3xl px-6 pt-16 pb-24">
        {/* Crumb */}
        <nav className="mb-12 flex items-center gap-3 text-sm">
          <Link href="/" className="text-[#4a5568] hover:text-[#8b95a8]">
            ghola
          </Link>
          <span className="text-[#4a5568] font-mono">/</span>
          <span className="text-[#4a5568]">m</span>
          <span className="text-[#4a5568] font-mono">/</span>
          <span className="text-[#eef1f8] font-medium font-mono">{slug}</span>
        </nav>

        <div className="mb-3 text-[11px] tracking-[0.12em] text-[#8b95a8]">
          › HEADLESS MERCHANT
        </div>
        <h1 className="mb-4 text-6xl font-medium tracking-[-0.03em] leading-[1.02]">
          {listing.name}
        </h1>
        {listing.description && (
          <p className="mb-16 max-w-xl text-[17px] leading-relaxed text-[#8b95a8]">
            {listing.description}
          </p>
        )}

        {/* Gateway URL — the one thing callers care about */}
        <div className="mb-16">
          <div className="mb-3 text-[11px] tracking-[0.12em] text-[#8b95a8]">
            › GATEWAY
          </div>
          <div className="border-l-2 border-[#3da8ff] bg-[#0b0e14] px-5 py-4 font-mono text-[14px] text-[#eef1f8] break-all">
            {listing.gateway_url}
          </div>
          <p className="mt-3 text-xs text-[#4a5568] leading-relaxed">
            Hit this URL from any x402-capable agent. Ghola verifies the
            payment, injects the merchant&apos;s auth, meters on success, and
            settles USDC to the wallet below.
          </p>
        </div>

        {/* Price + stats */}
        <div className="grid grid-cols-2 gap-12 mb-16">
          <div>
            <div className="mb-2 text-[11px] tracking-[0.12em] text-[#8b95a8]">
              › PRICE
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-5xl font-medium tracking-[-0.03em]">
                ${priceUsd}
              </span>
              <span className="text-sm text-[#4a5568] font-mono">/call</span>
            </div>
          </div>
          <div>
            <div className="mb-2 text-[11px] tracking-[0.12em] text-[#8b95a8]">
              › REVENUE
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-5xl font-medium tracking-[-0.03em]">
                ${revenueUsd}
              </span>
              <span className="text-sm text-[#4a5568] font-mono">
                {listing.total_requests.toLocaleString()} calls
              </span>
            </div>
          </div>
        </div>

        {/* Wallet */}
        {listing.wallet_address && (
          <div className="mb-16">
            <div className="mb-2 text-[11px] tracking-[0.12em] text-[#8b95a8]">
              › SOLANA WALLET
            </div>
            <div className="font-mono text-[13px] text-[#eef1f8] break-all">
              {listing.wallet_address}
            </div>
            <p className="mt-2 text-xs text-[#4a5568]">
              Settlement USDC arrives here hourly. Non-custodial —
              Ghola cannot sign withdrawals.
            </p>
          </div>
        )}

        {/* Status + dashboard link */}
        <div className="flex items-center justify-between pt-8 border-t border-[#1e2a3a]">
          <span
            className={`text-[11px] tracking-[0.12em] font-medium ${
              listing.status === "active" ? "text-[#3da8ff]" : "text-[#8b95a8]"
            }`}
          >
            › {listing.status.toUpperCase()}
          </span>
          <Link
            href={`/m/${slug}/dash`}
            className="text-[11px] tracking-[0.12em] text-[#eef1f8] hover:text-[#3da8ff]"
          >
            DASHBOARD →
          </Link>
        </div>
      </div>
    </div>
  );
}

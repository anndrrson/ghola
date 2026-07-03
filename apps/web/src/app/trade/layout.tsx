import type { Metadata } from "next";
import type { ReactNode } from "react";

const TRADE_URL = "https://ghola.xyz/trade";
const TITLE = "Trade Phoenix with a Ghola agent";
const DESCRIPTION =
  "Private AI trading agents for live markets. Capped intent, sealed execution, verifiable receipts.";
const IMAGE = {
  url: "https://ghola.xyz/og/trade-like-a-ghost-v2",
  width: 1200,
  height: 630,
  type: "image/png",
  alt: "ghola — trade like a ghost",
};

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: {
    canonical: TRADE_URL,
  },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: TRADE_URL,
    siteName: "ghola",
    type: "website",
    images: [IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: [IMAGE],
  },
};

export default function TradeLayout({ children }: { children: ReactNode }) {
  return children;
}

import type { Metadata } from "next";
import { Geist, Geist_Mono, Funnel_Display } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import { ThumperAuthProvider } from "@/lib/thumper-auth-context";
import { AppWalletProvider } from "@/lib/wallet-provider";
import { LayoutShell } from "@/components/LayoutShell";
import { ServiceWorker } from "@/components/ServiceWorker";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const funnelDisplay = Funnel_Display({
  variable: "--font-display",
  subsets: ["latin"],
});

// metadataBase tells Next.js how to resolve relative URLs in the
// metadata blocks below. If the site ever moves off the apex domain
// this is the one place to flip.
const SITE_URL = "https://ghola.xyz";
const SOCIAL_IMAGE_URL = `${SITE_URL}/og/trade-like-a-ghost-v2`;

const SHARED_TITLE = "ghola — trade like a ghost";
const SHARED_DESCRIPTION =
  "Private AI agents for live markets. Captured intent, sealed execution, verifiable receipts.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SHARED_TITLE,
  description: SHARED_DESCRIPTION,
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "ghola",
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
  // Open Graph block. Use an explicit versioned social-image URL so
  // crawlers that aggressively cache card assets have to fetch the
  // current "Trade like a ghost" preview.
  openGraph: {
    title: SHARED_TITLE,
    description: SHARED_DESCRIPTION,
    url: SITE_URL,
    siteName: "ghola",
    type: "website",
    locale: "en_US",
    images: [
      {
        url: SOCIAL_IMAGE_URL,
        width: 1200,
        height: 630,
        type: "image/png",
        alt: SHARED_TITLE,
      },
    ],
  },
  // summary_large_image is the wide-card variant Twitter/X uses.
  twitter: {
    card: "summary_large_image",
    title: SHARED_TITLE,
    description: SHARED_DESCRIPTION,
    images: [
      {
        url: SOCIAL_IMAGE_URL,
        alt: SHARED_TITLE,
      },
    ],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <head>
        <meta name="theme-color" content="#08090d" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        {/* ───────────── Resource hints ─────────────
            preconnect = warm TCP+TLS+DNS for hosts we *will* hit on
            the critical path. dns-prefetch = lighter, just resolves
            DNS — used for hosts we *might* hit but don't want to pay
            the TLS handshake cost on every cold load.

            Origins targeted:
              • api.devnet.solana.com         — registry RPC for the
                ModelIntegrityBadge / on-chain lookup.
              • huggingface.co                — WebLLM model weight CDN.
              • raw.githubusercontent.com     — WebLLM WASM model-lib CDN.
              • ghola-api.onrender.com        — said-cloud (DNS only,
                most visitors don't hit it until they sign in).
              • ghola-gateway.onrender.com    — gateway (same).

            `crossOrigin` is required on preconnect for any origin we
            fetch with CORS, otherwise the browser opens a second
            anonymous connection and the preconnect is wasted. */}
        <link
          rel="preconnect"
          href="https://api.devnet.solana.com"
          crossOrigin="anonymous"
        />
        <link
          rel="preconnect"
          href="https://huggingface.co"
          crossOrigin="anonymous"
        />
        <link
          rel="preconnect"
          href="https://raw.githubusercontent.com"
          crossOrigin="anonymous"
        />
        <link rel="dns-prefetch" href="https://ghola-api.onrender.com" />
        <link rel="dns-prefetch" href="https://ghola-gateway.onrender.com" />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${funnelDisplay.variable} bg-[#08090d] text-[#eef1f8] font-sans antialiased`}
      >
        <ServiceWorker />
        <AuthProvider>
          <ThumperAuthProvider>
            <AppWalletProvider>
              <LayoutShell>{children}</LayoutShell>
            </AppWalletProvider>
          </ThumperAuthProvider>
        </AuthProvider>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}

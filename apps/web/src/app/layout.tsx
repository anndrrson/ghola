import type { Metadata } from "next";
import { Geist, Geist_Mono, Funnel_Display } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import { ThumperAuthProvider } from "@/lib/thumper-auth-context";
import { AppWalletProvider } from "@/lib/wallet-provider";
import { LayoutShell } from "@/components/LayoutShell";
import { ServiceWorker } from "@/components/ServiceWorker";

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
// metadata blocks below (opengraph-image.tsx ships its own absolute
// URL, but openGraph.url and friends need this as a base). If the
// site ever moves off the apex domain this is the one place to flip.
const SITE_URL = "https://ghola.xyz";

const SHARED_TITLE = "ghola | Private execution for onchain markets";
const SHARED_DESCRIPTION = "Private execution for onchain markets.";
const SOCIAL_IMAGE = "/og-onchain-markets-v1.png";

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
  // Keep the image URL versioned so social platforms fetch a fresh card
  // when the positioning changes.
  openGraph: {
    title: SHARED_TITLE,
    description: SHARED_DESCRIPTION,
    url: SITE_URL,
    siteName: "ghola",
    type: "website",
    locale: "en_US",
    images: [
      {
        url: SOCIAL_IMAGE,
        width: 1200,
        height: 630,
        alt: SHARED_DESCRIPTION,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: SHARED_TITLE,
    description: SHARED_DESCRIPTION,
    images: [{ url: SOCIAL_IMAGE, alt: SHARED_DESCRIPTION }],
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
        {/* DNS-only hints keep cold loads light. Heavy RPC/model hosts are
            warmed when their feature surfaces load, not on the public hero. */}
        <link rel="dns-prefetch" href="https://api.devnet.solana.com" />
        <link rel="dns-prefetch" href="https://huggingface.co" />
        <link rel="dns-prefetch" href="https://raw.githubusercontent.com" />
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
      </body>
    </html>
  );
}

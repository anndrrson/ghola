import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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

export const metadata: Metadata = {
  title: "ghola — your AI personal assistant",
  description:
    "Your AI assistant that actually does things. Make calls, send emails, manage your calendar, send crypto — all from chat.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "ghola",
  },
  other: {
    "mobile-web-app-capable": "yes",
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
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} bg-[#08090d] text-[#eef1f8] font-sans antialiased`}
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

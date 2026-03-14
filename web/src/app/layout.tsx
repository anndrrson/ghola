import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import { ThumperAuthProvider } from "@/lib/thumper-auth-context";
import { AppWalletProvider } from "@/lib/wallet-provider";
import { LayoutShell } from "@/components/LayoutShell";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Ghola — Your AI Personal Assistant",
  description:
    "Your AI assistant that actually does things. Make calls, send emails, manage your calendar — all from chat.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} bg-[#08090d] text-[#eef1f8] font-sans antialiased`}
      >
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

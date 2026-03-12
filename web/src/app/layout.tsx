import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import { AppWalletProvider } from "@/lib/wallet-provider";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Ghola — AI Agent Identity & Vault",
  description:
    "One vault. Every AI provider. Portable memory, keys, and preferences that follow your agents.",
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
          <AppWalletProvider>
            <Navbar />
            <main>{children}</main>
            <Footer />
          </AppWalletProvider>
        </AuthProvider>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AppWalletProvider } from "@/lib/wallet-provider";
import Navbar from "@/components/Navbar";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "kinakuta - AI Model Marketplace",
  description: "AI models by your favorite creators",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} min-h-screen bg-[#0a0a0a] text-[#fafafa] antialiased`}
      >
        <AppWalletProvider>
          <Navbar />
          <main>{children}</main>
        </AppWalletProvider>
      </body>
    </html>
  );
}

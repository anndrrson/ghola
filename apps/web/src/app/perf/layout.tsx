import type { Metadata } from "next";

// The /perf surface is a developer diagnostics area, not a product
// page. Robots-noindex at the segment level so even if someone shares
// a URL it doesn't enter the index. The route is also absent from
// app/sitemap.ts's allowlist.

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: "Perf diagnostics",
};

export default function PerfLayout({ children }: { children: React.ReactNode }) {
  return children;
}

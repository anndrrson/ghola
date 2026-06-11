"use client";

import { usePathname } from "next/navigation";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";

const BARE_ROUTES = ["/chat", "/trade", "/signup", "/signin"];

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isBareRoute = pathname === "/" || BARE_ROUTES.some((r) => pathname.startsWith(r));

  if (isBareRoute) {
    return <>{children}</>;
  }

  return (
    <>
      <Navbar />
      <main>{children}</main>
      <Footer />
    </>
  );
}

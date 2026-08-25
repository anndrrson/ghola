import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Carry — Ghola",
  description: "Compare and manage delta-neutral perpetual carry across venues.",
};

export default function CarryPage() {
  redirect("/trade?product=perps&venue=hyperliquid&market=BTC-PERP&carry=open");
}

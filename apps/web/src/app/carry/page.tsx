import type { Metadata } from "next";
import { CarryWorkspace } from "@/components/carry/CarryWorkspace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Carry — Ghola",
  description: "Compare and manage delta-neutral perpetual carry across venues.",
};

export default function CarryPage() {
  return <CarryWorkspace />;
}

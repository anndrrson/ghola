import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Founding Trader | Ghola",
  description:
    "Join Ghola's capped 10-seat Founding Trader cohort for private trading infrastructure and explicit mainnet readiness checks.",
};

export default function FoundingLayout({ children }: { children: React.ReactNode }) {
  return children;
}

import { notFound } from "next/navigation";
import { FundedMainnetRoundTrip } from "@/components/trade/FundedMainnetRoundTrip";
import { hyperliquidMainnetProofUiEnabled } from "@/app/v1/private-account/_lib";

export default function FundedMainnetRoundTripPage() {
  if (!hyperliquidMainnetProofUiEnabled()) notFound();
  return <FundedMainnetRoundTrip />;
}

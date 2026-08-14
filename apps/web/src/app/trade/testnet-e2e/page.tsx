import { notFound } from "next/navigation";
import { FundedTestnetRoundTrip } from "@/components/trade/FundedTestnetRoundTrip";

export default function FundedTestnetRoundTripPage() {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.GHOLA_HYPERLIQUID_FUNDED_TESTNET_UI_ENABLED !== "true"
  ) notFound();

  const market = /^[A-Z0-9]{2,12}$/.test(process.env.GHOLA_HYPERLIQUID_TESTNET_MARKET ?? "")
    ? process.env.GHOLA_HYPERLIQUID_TESTNET_MARKET!
    : "HYPE";
  const configuredNotional = Number(process.env.GHOLA_HYPERLIQUID_TESTNET_ROUNDTRIP_NOTIONAL_USD ?? "11");
  const notionalUsd = Number.isFinite(configuredNotional) && configuredNotional >= 10 && configuredNotional <= 15
    ? configuredNotional
    : 11;
  return <FundedTestnetRoundTrip market={market} notionalUsd={notionalUsd} />;
}

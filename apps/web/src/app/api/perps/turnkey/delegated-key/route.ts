import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const P256_PUBLIC_KEY = /^(?:04[0-9a-f]{128}|0[23][0-9a-f]{64})$/i;

export async function GET() {
  const publicKey = process.env.GHOLA_TURNKEY_AGENT_API_PUBLIC_KEY?.trim() || "";
  const mainnet = process.env.GHOLA_PERPS_NETWORK === "mainnet" &&
    process.env.GHOLA_PERPS_MAINNET_ENABLED === "true";
  const network = mainnet ? "mainnet" : "testnet";
  const configured = P256_PUBLIC_KEY.test(publicKey);
  return NextResponse.json({
    version: 1,
    configured,
    network,
    key_ref: process.env.GHOLA_TURNKEY_AGENT_KEY_REF?.trim() || "ghola-worker-v1",
    public_key: configured ? publicKey : null,
    no_submit_default: process.env.GHOLA_PERPS_LIVE_SUBMIT !== "true",
    live_submit_enabled: process.env.GHOLA_PERPS_LIVE_SUBMIT === "true",
    custody: {
      wallet_keys: "turnkey",
      trading_collateral: "hyperliquid_hypercore",
      withdrawals: "owner_only",
    },
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}

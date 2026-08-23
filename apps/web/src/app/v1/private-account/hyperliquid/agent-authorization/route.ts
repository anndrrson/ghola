import {
  hyperliquidAgentAuthorizationStatus,
  json,
  privateAccountOwnerFromRequest,
  unauthorized,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  const url = new URL(req.url);
  const network = url.searchParams.get("network");
  const ownerAddress = url.searchParams.get("owner") || "";
  const agentAddress = url.searchParams.get("agent") || "";
  if (network !== "mainnet" && network !== "testnet") {
    return json({ error: "hyperliquid_network_invalid" }, 400);
  }
  const result = await hyperliquidAgentAuthorizationStatus({
    network,
    owner_address: ownerAddress,
    agent_address: agentAddress,
  });
  if (result.status === "invalid") {
    return json({ error: "hyperliquid_address_invalid" }, 400);
  }
  if (result.status === "unavailable") {
    return json({ error: "hyperliquid_binding_check_unavailable" }, 503);
  }
  return json({
    version: 1,
    network,
    owner_address: ownerAddress.toLowerCase(),
    agent_address: agentAddress.toLowerCase(),
    status: result.status,
    authorized: result.authorized,
  });
}

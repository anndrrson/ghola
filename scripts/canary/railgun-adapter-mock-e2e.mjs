#!/usr/bin/env node
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRailgunAdapterServer } from "../../apps/railgun-adapter/src/server.js";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function mockRpcServer() {
  return createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const result =
      body.method === "eth_blockNumber"
        ? "0x20"
        : {
            status: "0x1",
            blockNumber: "0x20",
            to: "0xrailgun",
            logs: [{ address: "0xrailgun" }]
          };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function main() {
  const keyPair = generateKeyPairSync("ed25519");
  const rpc = mockRpcServer();
  const rpcUrl = await listen(rpc);
  const config = {
    authToken: "mock-secret",
    signingKey: keyPair.privateKey,
    network: "arbitrum",
    asset: "USDC",
    recipient: "0zkrecipient000000000000000000000",
    rpcUrl,
    contractAddress: "0xrailgun",
    minConfirmations: 1,
    broadcasterReady: true,
    proofOfInnocenceRequired: true,
    proofOfInnocenceConfigured: true,
    receiptTtlSeconds: 600
  };
  const adapter = createRailgunAdapterServer(config);
  const adapterUrl = await listen(adapter);

  try {
    const health = await fetch(`${adapterUrl}/health`);
    if (!health.ok) throw new Error(`health failed: ${health.status}`);
    const healthJson = await health.json();
    if (healthJson.ready !== true || healthJson.fallback_allowed !== false) {
      throw new Error(`unexpected health body: ${JSON.stringify(healthJson)}`);
    }

    const fixture = JSON.parse(
      await readFile(
        new URL("../../apps/railgun-adapter/fixtures/thumper-cloud-verify-request.json", import.meta.url),
        "utf8"
      )
    );
    const verified = await fetch(`${adapterUrl}/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer mock-secret"
      },
      body: JSON.stringify(fixture)
    });
    if (!verified.ok) {
      throw new Error(`verify failed: ${verified.status} ${await verified.text()}`);
    }
    const verifiedJson = await verified.json();
    if (
      verifiedJson.settled !== true ||
      verifiedJson.provider !== "railgun" ||
      verifiedJson.network !== "arbitrum" ||
      !verifiedJson.adapter_signature_b64
    ) {
      throw new Error(`unexpected verify body: ${JSON.stringify(verifiedJson)}`);
    }

    const bad = structuredClone(fixture);
    delete bad.proof.extensions.railgun.proof_of_innocence_id;
    const rejected = await fetch(`${adapterUrl}/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer mock-secret"
      },
      body: JSON.stringify(bad)
    });
    if (rejected.ok) throw new Error("missing proof policy was accepted");

    console.error(`mock Railgun adapter canary passed at ${adapterUrl}`);
  } finally {
    await close(adapter);
    await close(rpc);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

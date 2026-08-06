import { describe, expect, it } from "vitest";
import {
  configuredHyperliquidWorkerShards,
  healthyHyperliquidWorkerShards,
  hyperliquidWorkerShardToken,
  resolveHyperliquidWorkerShard,
  selectHyperliquidWorkerShard,
} from "./hyperliquid-worker-shards";

const config = JSON.stringify(Array.from({ length: 10 }, (_, index) => ({
  id: `hl-${String(index).padStart(2, "0")}`,
  url: `https://hl-${index}.example.test`,
  recipient_id: `phala:hl-${index}`,
  x25519_pub_hex: String(index).padStart(2, "0").repeat(32),
  image_digest: `sha256:${String(index).padStart(2, "0").repeat(32)}`,
  token_env: `HL_SHARD_${index}_TOKEN`,
  attested_ready: true,
})));

describe("Hyperliquid worker shard routing", () => {
  it("keeps an account on a deterministic shard", () => {
    const shards = configuredHyperliquidWorkerShards({
      NODE_ENV: "test",
      GHOLA_HYPERLIQUID_WORKER_SHARDS_JSON: config,
    });
    expect(shards).toHaveLength(10);
    expect(selectHyperliquidWorkerShard(shards, "account_abc")).toEqual(
      selectHyperliquidWorkerShard(shards, "account_abc"),
    );
  });

  it("uses the durable vault recipient instead of rehashing after deployment", () => {
    const shards = configuredHyperliquidWorkerShards({
      NODE_ENV: "test",
      GHOLA_HYPERLIQUID_WORKER_SHARDS_JSON: config,
    });
    expect(resolveHyperliquidWorkerShard(shards, {
      recipientId: "phala:hl-7",
      accountCommitment: "a_different_hash",
    })?.id).toBe("hl-07");
  });

  it("rejects the entire configuration when recipients are duplicated", () => {
    const duplicate = JSON.stringify([
      JSON.parse(config)[0],
      { ...JSON.parse(config)[1], recipient_id: "phala:hl-0" },
    ]);
    expect(configuredHyperliquidWorkerShards({
      NODE_ENV: "test",
      GHOLA_HYPERLIQUID_WORKER_SHARDS_JSON: duplicate,
    })).toEqual([]);
  });

  it("resolves secrets by environment-variable name without storing them in shard JSON", () => {
    const shard = configuredHyperliquidWorkerShards({
      NODE_ENV: "test",
      GHOLA_HYPERLIQUID_WORKER_SHARDS_JSON: config,
    })[0];
    expect(hyperliquidWorkerShardToken(shard, { HL_SHARD_0_TOKEN: "secret" })).toBe("secret");
  });

  it("requires live health and exact recipient binding outside local tests", async () => {
    const shard = configuredHyperliquidWorkerShards({
      NODE_ENV: "test",
      GHOLA_HYPERLIQUID_WORKER_SHARDS_JSON: config,
    })[0];
    const healthy = await healthyHyperliquidWorkerShards(
      [shard],
      { NODE_ENV: "production" },
      (async (input: URL | RequestInfo) => {
        const url = String(input);
        return Response.json(url.endsWith("/health")
          ? { status: "green", ready: true, attested_ready: true, image_digest: shard.image_digest }
          : {
              attested_ready: true,
              recipient_id: shard.recipient_id,
              x25519_pub_hex: shard.x25519_pub_hex,
              image_digest: shard.image_digest,
            });
      }) as typeof fetch,
    );
    expect(healthy).toEqual([shard]);

    const mismatched = await healthyHyperliquidWorkerShards(
      [{ ...shard, url: "https://mismatch.example.test" }],
      { NODE_ENV: "production" },
      (async (input: URL | RequestInfo) => Response.json(String(input).endsWith("/health")
        ? { status: "green", ready: true, attested_ready: true, image_digest: shard.image_digest }
        : {
            attested_ready: true,
            recipient_id: "phala:wrong",
            x25519_pub_hex: shard.x25519_pub_hex,
            image_digest: shard.image_digest,
          })) as typeof fetch,
    );
    expect(mismatched).toEqual([]);

    const staleImage = await healthyHyperliquidWorkerShards(
      [{ ...shard, url: "https://stale.example.test" }],
      { NODE_ENV: "production" },
      (async (input: URL | RequestInfo) => Response.json(String(input).endsWith("/health")
        ? { status: "green", ready: true, attested_ready: true, image_digest: "sha256:" + "ff".repeat(32) }
        : {
            attested_ready: true,
            recipient_id: shard.recipient_id,
            x25519_pub_hex: shard.x25519_pub_hex,
            image_digest: shard.image_digest,
          })) as typeof fetch,
    );
    expect(staleImage).toEqual([]);
  });
});

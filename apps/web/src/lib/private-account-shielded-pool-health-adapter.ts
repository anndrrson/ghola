import { Connection, PublicKey } from "@solana/web3.js";

import { gholaCommitment } from "./private-account";
import { solanaShieldedVerifierConfig } from "./private-account-solana-shielded-verifier";

type Service = "indexer" | "prover" | "relayer";

export async function shieldedPoolAdapterHealth(service: Service, now: Date = new Date()) {
  const config = solanaShieldedVerifierConfig();
  const missing = [
    ["program_id", config.programId],
    ["mint", config.mint],
    ["tree_id", config.treeId],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    return {
      status: 503,
      body: body({ service, status: "red", now, reason: `missing ${missing.join(", ")}` }),
    };
  }

  if (service !== "indexer") {
    return {
      status: 200,
      body: body({
        service,
        status: "green",
        now,
        commitment: gholaCommitment(`shielded_pool_${service}`, {
          network: config.network,
          program_id: config.programId,
          mint: config.mint,
          tree_id: config.treeId,
        }),
        extra: service === "prover"
          ? { backend: "solana-program-verifier-key", artifacts_present: true }
          : { relay_mode: "sealed-runtime-coordinator", queue_ready: true },
      }),
    };
  }

  try {
    const connection = new Connection(config.rpcUrl, "confirmed");
    const [slot, program, mint, tree] = await Promise.all([
      connection.getSlot("confirmed"),
      connection.getAccountInfo(new PublicKey(config.programId), "confirmed"),
      connection.getAccountInfo(new PublicKey(config.mint), "confirmed"),
      connection.getAccountInfo(new PublicKey(config.treeId), "confirmed"),
    ]);
    if (!program?.executable || !mint || !tree) {
      return {
        status: 503,
        body: body({
          service,
          status: "red",
          now,
          reason: !program?.executable
            ? "program is not executable"
            : !mint ? "mint is missing" : "tree is missing",
        }),
      };
    }
    return {
      status: 200,
      body: body({
        service,
        status: "green",
        now,
        commitment: gholaCommitment("shielded_pool_indexer", {
          network: config.network,
          program_id: config.programId,
          mint: config.mint,
          tree_id: config.treeId,
          slot,
        }),
        extra: { slot },
      }),
    };
  } catch {
    return {
      status: 503,
      body: body({ service, status: "red", now, reason: "Solana indexer health check failed" }),
    };
  }
}

export async function shieldedPoolTreeState(now: Date = new Date()) {
  const config = solanaShieldedVerifierConfig();
  if (!config.programId || !config.mint || !config.treeId) {
    return {
      status: 503,
      body: {
        ok: false,
        status: "red",
        reason: "program_id, mint, and tree_id are required",
        observed_at: null,
        checked_at: now.toISOString(),
      },
    };
  }
  try {
    const connection = new Connection(config.rpcUrl, "confirmed");
    const [slot, tree] = await Promise.all([
      connection.getSlot("confirmed"),
      connection.getAccountInfo(new PublicKey(config.treeId), "confirmed"),
    ]);
    if (!tree) {
      return {
        status: 503,
        body: {
          ok: false,
          status: "red",
          reason: "tree account is missing",
          observed_at: null,
          checked_at: now.toISOString(),
        },
      };
    }
    const root = tree.data.length >= 8 + 2048 + 32 + 32 + 32
      ? Buffer.from(tree.data.subarray(8 + 2048 + 32 + 32, 8 + 2048 + 32 + 32 + 32)).toString("hex")
      : null;
    const nextIndex = tree.data.length >= 8 + 2048 + 32 + 32 + 32 + 8
      ? Number(tree.data.readBigUInt64LE(8 + 2048 + 32 + 32 + 32))
      : null;
    return {
      status: 200,
      body: {
        ok: true,
        status: "green",
        network: config.network,
        root,
        root_commitment: root ? gholaCommitment("shielded_pool_tree_root", root) : null,
        next_index: nextIndex,
        depth: 26,
        slot,
        observed_at: now.toISOString(),
        indexed_at: now.toISOString(),
      },
    };
  } catch {
    return {
      status: 503,
      body: {
        ok: false,
        status: "red",
        reason: "tree-state read failed",
        observed_at: null,
        checked_at: now.toISOString(),
      },
    };
  }
}

function body(input: {
  service: Service;
  status: "green" | "red";
  now: Date;
  commitment?: string;
  reason?: string | null;
  extra?: Record<string, unknown>;
}) {
  return {
    ok: input.status === "green",
    status: input.status,
    service: input.service,
    commitment: input.commitment ?? null,
    observed_at: input.status === "green" ? input.now.toISOString() : null,
    checked_at: input.now.toISOString(),
    reason: input.reason ?? null,
    ...(input.extra ?? {}),
  };
}

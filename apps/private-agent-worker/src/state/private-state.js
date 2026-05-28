import { createHmac, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const STATE_VERSION = 1;

function emptyState() {
  return {
    version: STATE_VERSION,
    sessions: {},
    idempotency: {},
    policy_counts: {},
    policy_amounts: {},
    hyperliquid_managed_allocations: {},
    omnibus: {},
    updated_at: new Date().toISOString(),
  };
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function createWorkerState(dir) {
  mkdirSync(dir, { recursive: true });
  const statePath = join(dir, "private-agent-execution-state-v1.json");
  const hmacPath = join(dir, "private-agent-client-order-hmac.hex");
  if (!existsSync(hmacPath)) {
    writeFileSync(hmacPath, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  }
  const hmacSecret = readFileSync(hmacPath, "utf8").trim();

  function load() {
    const loaded = readJson(statePath, emptyState());
    return {
      ...emptyState(),
      ...loaded,
      sessions: loaded.sessions || {},
      idempotency: loaded.idempotency || {},
      policy_counts: loaded.policy_counts || {},
      policy_amounts: loaded.policy_amounts || {},
      hyperliquid_managed_allocations: loaded.hyperliquid_managed_allocations || {},
      omnibus: loaded.omnibus || {},
    };
  }

  function save(state) {
    writeJsonAtomic(statePath, {
      ...state,
      version: STATE_VERSION,
      updated_at: new Date().toISOString(),
    });
  }

  function hmacHex(parts) {
    return createHmac("sha256", Buffer.from(hmacSecret, "hex"))
      .update(parts.filter(Boolean).join("\0"))
      .digest("hex");
  }

  return {
    path: statePath,

    deriveClientOrderId(prefix, workOrderCommitment) {
      return `${prefix}_${hmacHex([prefix, workOrderCommitment]).slice(0, 32)}`;
    },

    deriveHyperliquidCloid(workOrderCommitment) {
      return `0x${hmacHex(["hyperliquid_cloid", workOrderCommitment]).slice(0, 32)}`;
    },

    getIdempotency(workOrderCommitment) {
      return load().idempotency[workOrderCommitment] || null;
    },

    putIdempotency(workOrderCommitment, receipt) {
      const state = load();
      state.idempotency[workOrderCommitment] = {
        receipt,
        updated_at: new Date().toISOString(),
      };
      save(state);
      return receipt;
    },

    putSession(session) {
      const state = load();
      state.sessions[session.session_commitment] = {
        ...session,
        updated_at: new Date().toISOString(),
      };
      save(state);
      return state.sessions[session.session_commitment];
    },

    findSession(input) {
      const sessions = Object.values(load().sessions);
      return sessions.find((session) => {
        if (input.venue_id && session.venue_id !== input.venue_id) return false;
        if (input.vault_commitment && session.vault_commitment !== input.vault_commitment) return false;
        if (input.policy_commitment && session.policy_commitment !== input.policy_commitment) return false;
        if (
          input.allocation_commitment &&
          session.allocation_commitment !== input.allocation_commitment
        ) {
          return false;
        }
        return true;
      }) || null;
    },

    putHyperliquidManagedAllocation(allocation) {
      const state = load();
      state.hyperliquid_managed_allocations[allocation.allocation_commitment] = {
        allocation,
        updated_at: new Date().toISOString(),
      };
      save(state);
      return state.hyperliquid_managed_allocations[allocation.allocation_commitment];
    },

    getHyperliquidManagedAllocation(allocationCommitment) {
      return load().hyperliquid_managed_allocations[allocationCommitment] || null;
    },

    incrementPolicyCount(key, maxCount) {
      const state = load();
      const current = state.policy_counts[key] || { count: 0, updated_at: null };
      if (Number.isInteger(maxCount) && current.count >= maxCount) {
        return { ok: false, count: current.count };
      }
      const next = {
        count: current.count + 1,
        updated_at: new Date().toISOString(),
      };
      state.policy_counts[key] = next;
      save(state);
      return { ok: true, count: next.count };
    },

    incrementPolicyAmount(key, amount, maxAmount) {
      const state = load();
      const parsedAmount = Number.parseFloat(String(amount || "0"));
      const parsedMax = Number.parseFloat(String(maxAmount || "0"));
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        return { ok: false, amount: 0 };
      }
      const current = state.policy_amounts[key] || { amount: 0, updated_at: null };
      const nextAmount = Number(current.amount || 0) + parsedAmount;
      if (Number.isFinite(parsedMax) && parsedMax > 0 && nextAmount > parsedMax) {
        return { ok: false, amount: Number(current.amount || 0) };
      }
      const next = {
        amount: nextAmount,
        updated_at: new Date().toISOString(),
      };
      state.policy_amounts[key] = next;
      save(state);
      return { ok: true, amount: next.amount };
    },

    putOmnibusAllocation(allocation) {
      const state = load();
      state.omnibus[allocation.allocation_commitment] = {
        allocation,
        reservations: state.omnibus[allocation.allocation_commitment]?.reservations || {},
        fills: state.omnibus[allocation.allocation_commitment]?.fills || {},
        updated_at: new Date().toISOString(),
      };
      save(state);
      return state.omnibus[allocation.allocation_commitment];
    },

    getOmnibusAllocation(allocationCommitment) {
      return load().omnibus[allocationCommitment] || null;
    },

    reserveOmnibus(input) {
      const state = load();
      const existing = state.omnibus[input.allocation_commitment] || {
        allocation: input.allocation || { allocation_commitment: input.allocation_commitment },
        reservations: {},
        fills: {},
      };
      existing.reservations[input.work_order_commitment] = {
        work_order_commitment: input.work_order_commitment,
        notional_bucket: input.notional_bucket,
        status: "reserved",
        created_at: new Date().toISOString(),
      };
      existing.updated_at = new Date().toISOString();
      state.omnibus[input.allocation_commitment] = existing;
      save(state);
      return existing.reservations[input.work_order_commitment];
    },

    releaseOmnibus(input) {
      const state = load();
      const existing = state.omnibus[input.allocation_commitment];
      if (existing?.reservations?.[input.work_order_commitment]) {
        existing.reservations[input.work_order_commitment].status = "released";
        existing.reservations[input.work_order_commitment].updated_at = new Date().toISOString();
        existing.updated_at = new Date().toISOString();
        save(state);
      }
    },

    settleOmnibusFill(input) {
      const state = load();
      const existing = state.omnibus[input.allocation_commitment] || {
        allocation: { allocation_commitment: input.allocation_commitment },
        reservations: {},
        fills: {},
      };
      existing.fills[input.fill_commitment] = {
        fill_commitment: input.fill_commitment,
        work_order_commitment: input.work_order_commitment,
        fee_bucket: input.fee_bucket || null,
        notional_bucket: input.notional_bucket || null,
        created_at: new Date().toISOString(),
      };
      if (existing.reservations[input.work_order_commitment]) {
        existing.reservations[input.work_order_commitment].status = "settled";
        existing.reservations[input.work_order_commitment].updated_at = new Date().toISOString();
      }
      existing.updated_at = new Date().toISOString();
      state.omnibus[input.allocation_commitment] = existing;
      save(state);
      return existing.fills[input.fill_commitment];
    },
  };
}

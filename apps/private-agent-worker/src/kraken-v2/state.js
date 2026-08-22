import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const EMPTY = {
  connections: {},
  mandates: {},
  intents: {},
  snapshots: {},
  runs: {},
  child_orders: {},
  receipts: {},
  leases: {},
};

export function createKrakenV2State(env = process.env, options = {}) {
  if (options.state) return options.state;
  const file = env.PRIVATE_AGENT_KRAKEN_V2_STATE_FILE?.trim();
  const live = env.PRIVATE_AGENT_KRAKEN_V2_LIVE_SUBMIT === "true";
  if (live && !file) {
    throw new Error(
      "PRIVATE_AGENT_KRAKEN_V2_STATE_FILE is required for live Kraken execution",
    );
  }
  return new KrakenV2State(file ? resolve(file) : null);
}

export class KrakenV2State {
  constructor(file = null) {
    this.file = file;
    this.data = structuredClone(EMPTY);
    this.loaded = false;
    this.queue = Promise.resolve();
  }

  async putConnection(connection) {
    return this.mutate((data) => {
      const previous = data.connections[connection.connection_id];
      data.connections[connection.connection_id] = {
        ...previous,
        ...connection,
        status: connection.status || previous?.status || "active",
        linked_at: previous?.linked_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      return structuredClone(data.connections[connection.connection_id]);
    });
  }

  async getConnection(connectionId) {
    return this.read((data) => clone(data.connections[connectionId] || null));
  }

  async setConnectionStatus(connectionId, status, reason = null) {
    return this.mutate((data) => {
      const connection = required(data.connections[connectionId], "connection");
      connection.status = status;
      connection.status_reason = reason;
      connection.updated_at = new Date().toISOString();
      return clone(connection);
    });
  }

  async listActiveConnections() {
    return this.read((data) => Object.values(data.connections)
      .filter((item) => item.status === "active")
      .map(clone));
  }

  async putMandate(mandate) {
    return this.mutate((data) => {
      data.mandates[mandate.connection_id] = {
        ...mandate,
        updated_at: new Date().toISOString(),
      };
      return clone(data.mandates[mandate.connection_id]);
    });
  }

  async getMandate(connectionId) {
    return this.read((data) => clone(data.mandates[connectionId] || null));
  }

  async putIntent(intent) {
    return this.mutate((data) => {
      const key = `${intent.connection_id}:${intent.sleeve_id}`;
      const records = data.intents[key] ||= [];
      const duplicate = records.find((item) => item.idempotency_key === intent.idempotency_key);
      if (duplicate) return { intent: clone(duplicate), duplicate: true };
      const last = records.at(-1);
      if (last && intent.sequence <= last.sequence) {
        const error = new Error("intent sequence must increase");
        error.code = "stale_intent_sequence";
        error.status = 409;
        throw error;
      }
      records.push({ ...intent, accepted_at: new Date().toISOString() });
      return { intent: clone(records.at(-1)), duplicate: false };
    });
  }

  async listIntents(connectionId) {
    return this.read((data) => Object.entries(data.intents)
      .filter(([key]) => key.startsWith(`${connectionId}:`))
      .flatMap(([, records]) => records)
      .map(clone));
  }

  async putSnapshot(connectionId, snapshot) {
    return this.mutate((data) => {
      data.snapshots[connectionId] = snapshot;
      return clone(snapshot);
    });
  }

  async getSnapshot(connectionId) {
    return this.read((data) => clone(data.snapshots[connectionId] || null));
  }

  async createRun(run) {
    return this.mutate((data) => {
      if (data.runs[run.run_id]) return clone(data.runs[run.run_id]);
      data.runs[run.run_id] = run;
      return clone(run);
    });
  }

  async updateRun(runId, patch) {
    return this.mutate((data) => {
      const run = required(data.runs[runId], "run");
      Object.assign(run, patch, { updated_at: new Date().toISOString() });
      return clone(run);
    });
  }

  async putChildOrder(order) {
    return this.mutate((data) => {
      const previous = data.child_orders[order.client_order_id];
      data.child_orders[order.client_order_id] = { ...previous, ...order };
      return clone(data.child_orders[order.client_order_id]);
    });
  }

  async listChildOrders(connectionId) {
    return this.read((data) => Object.values(data.child_orders)
      .filter((item) => item.connection_id === connectionId)
      .map(clone));
  }

  async putReceipt(receipt) {
    return this.mutate((data) => {
      data.receipts[receipt.receipt_id] = receipt;
      return clone(receipt);
    });
  }

  async listReceipts(connectionId, limit = 50) {
    return this.read((data) => Object.values(data.receipts)
      .filter((item) => item.connection_id === connectionId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map(clone));
  }

  async claimLease(connectionId, ttlMs = 60_000) {
    return this.mutate((data) => {
      const now = Date.now();
      const current = data.leases[connectionId];
      if (current && Date.parse(current.expires_at) > now) return null;
      const lease = {
        token: randomUUID(),
        expires_at: new Date(now + ttlMs).toISOString(),
      };
      data.leases[connectionId] = lease;
      return clone(lease);
    });
  }

  async releaseLease(connectionId, token) {
    return this.mutate((data) => {
      if (data.leases[connectionId]?.token === token) delete data.leases[connectionId];
      return true;
    });
  }

  async dailyTurnoverUsd(connectionId, now = new Date()) {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    return this.read((data) => Object.values(data.child_orders)
      .filter((item) =>
        item.connection_id === connectionId &&
        Date.parse(item.created_at) >= start.getTime() &&
        ["submitted", "partially_filled", "filled"].includes(item.status))
      .reduce((sum, item) => sum + Math.abs(Number(item.notional_usd || 0)), 0));
  }

  async read(fn) {
    await this.load();
    await this.queue;
    return fn(this.data);
  }

  async mutate(fn) {
    await this.load();
    const operation = this.queue.then(async () => {
      const result = fn(this.data);
      await this.persist();
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      this.data = { ...structuredClone(EMPTY), ...JSON.parse(await readFile(this.file, "utf8")) };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async persist() {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }
}

function required(value, name) {
  if (value) return value;
  const error = new Error(`${name} not found`);
  error.code = `${name}_not_found`;
  error.status = 404;
  throw error;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

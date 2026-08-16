import { describe, expect, it } from "vitest";
import type { GholaChartCandle } from "./ghola-market-chart";
import {
  GHOLA_CHART_DRAWING_GUEST_SCOPE,
  GHOLA_CHART_DRAWING_LEGACY_STORAGE_KEY,
  GHOLA_CHART_DRAWING_RECORD_LIMIT,
  GHOLA_CHART_DRAWING_REPLAY_READ_ONLY_REASON,
  GHOLA_CHART_DRAWING_STORAGE_LOCKED_REASON,
  GHOLA_CHART_TREND_LINE_LIMIT,
  emptyGholaChartDrawingPayload,
  emptyGholaChartDrawingStorage,
  gholaChartDrawingConcurrentScopeConflict,
  gholaChartDrawingPayloadForCandles,
  gholaChartDrawingPayloadEqual,
  gholaChartDrawingMutationPolicy,
  gholaChartDrawingRecordForIdentity,
  gholaChartDrawingScope,
  gholaChartDrawingStorageKey,
  inspectGholaChartDrawingStorage,
  loadGholaChartDrawingPayload,
  mergeGholaChartDrawingStorage,
  parseGholaChartDrawingStorage,
  persistGholaChartDrawingPayload,
  reconcileGholaChartDrawingStorage,
  serializeGholaChartDrawingStorage,
  updateGholaChartDrawingRecord,
  writeGholaChartDrawingPayload,
  writeGholaChartDrawingPayloadGuarded,
  type GholaChartDrawingIdentity,
  type GholaChartDrawingPayload,
  type GholaChartDrawingStorageLike,
} from "./ghola-chart-drawing-storage";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");
const START = Date.parse("2026-08-12T00:00:00.000Z");
const MAINNET = identity("hyperliquid:mainnet:BTC:5m");
const TESTNET = identity("hyperliquid:testnet:BTC:5m");
const SUBJECT_A = `subject_${"a".repeat(32)}`;
const SUBJECT_B = `subject_${"b".repeat(32)}`;

describe("ghola chart drawing storage", () => {
  it("makes drawing mutations read-only during historical replay", () => {
    expect(gholaChartDrawingMutationPolicy({ replayActive: false, sourceCertified: true })).toEqual({
      allowed: true,
      disabledReason: null,
    });
    expect(gholaChartDrawingMutationPolicy({ replayActive: true, sourceCertified: true })).toEqual({
      allowed: false,
      disabledReason: GHOLA_CHART_DRAWING_REPLAY_READ_ONLY_REASON,
    });
  });

  it("makes stale or synthetic chart sources read-only", () => {
    expect(gholaChartDrawingMutationPolicy({ replayActive: false, sourceCertified: false })).toEqual({
      allowed: false,
      disabledReason: "Drawings are read-only until public candle history is certified.",
    });
  });

  it("locks drawing mutations before replay/source checks when saved data is unreadable", () => {
    expect(gholaChartDrawingMutationPolicy({
      replayActive: false,
      sourceCertified: true,
      storageBlocked: true,
    })).toEqual({
      allowed: false,
      disabledReason: GHOLA_CHART_DRAWING_STORAGE_LOCKED_REASON,
    });
  });

  it("strictly inspects current storage while preserving unreadable raw data", () => {
    const malformed = "{broken-drawings";
    expect(inspectGholaChartDrawingStorage(null, NOW)).toEqual({
      status: "absent",
      storage: emptyGholaChartDrawingStorage(),
      raw: null,
    });
    expect(inspectGholaChartDrawingStorage(malformed, NOW)).toEqual({
      status: "blocked",
      storage: null,
      raw: malformed,
    });

    const futureRecord = JSON.stringify({
      version: 1,
      records: [{
        identity: MAINNET,
        updatedAt: NOW + 1,
        anchoredVwap: null,
        trendLines: [],
      }],
    });
    expect(inspectGholaChartDrawingStorage(futureRecord, NOW)).toEqual({
      status: "blocked",
      storage: null,
      raw: futureRecord,
    });

    const corruptDrawing = JSON.stringify({
      version: 1,
      records: [{
        identity: MAINNET,
        updatedAt: NOW,
        anchoredVwap: null,
        trendLines: [{ ...trend("bad", 0, 1), first: { time: START, price: null } }],
      }],
    });
    expect(inspectGholaChartDrawingStorage(corruptDrawing, NOW)?.status).toBe("blocked");

    const valid = serializeGholaChartDrawingStorage(
      updateGholaChartDrawingRecord(emptyGholaChartDrawingStorage(), MAINNET, payload("valid", 0), NOW),
      NOW,
    );
    expect(inspectGholaChartDrawingStorage(valid, NOW)).toMatchObject({
      status: "ready",
      raw: valid,
    });
  });

  it("does not alter blocked raw storage until an explicit replacement write", () => {
    const storage = memoryStorage();
    const key = gholaChartDrawingStorageKey(MAINNET.persistenceScope)!;
    const raw = "{future-or-corrupt-drawings";
    storage.setItem(key, raw);

    expect(inspectGholaChartDrawingStorage(storage.getItem(key), NOW).status).toBe("blocked");
    expect(storage.getItem(key)).toBe(raw);

    const reset = writeGholaChartDrawingPayload(
      storage,
      MAINNET,
      emptyGholaChartDrawingPayload(),
      candles(8),
      emptyGholaChartDrawingStorage(),
      NOW,
    );
    expect(reset).not.toBeNull();
    expect(storage.getItem(key)).not.toBe(raw);
    expect(inspectGholaChartDrawingStorage(storage.getItem(key), NOW).status).toBe("ready");
  });

  it("isolates otherwise identical Hyperliquid charts by replay network identity", () => {
    const storage = memoryStorage();
    expect(persistGholaChartDrawingPayload(storage, MAINNET, payload("main", 0), candles(8), NOW)).toBe(true);
    expect(persistGholaChartDrawingPayload(storage, TESTNET, payload("test", 1), candles(8), NOW)).toBe(true);

    expect(gholaChartDrawingScope(MAINNET)).not.toBe(gholaChartDrawingScope(TESTNET));
    expect(loadGholaChartDrawingPayload(storage, MAINNET, candles(8), NOW)?.trendLines[0].id).toBe("main");
    expect(loadGholaChartDrawingPayload(storage, TESTNET, candles(8), NOW)?.trendLines[0].id).toBe("test");
  });

  it("isolates identical drawings by account and leaves the legacy global payload untouched", () => {
    const storage = memoryStorage();
    const accountA = identity("hyperliquid:mainnet:BTC:5m", "hyperliquid", "BTC-PERP", SUBJECT_A);
    const accountB = identity("hyperliquid:mainnet:BTC:5m", "hyperliquid", "BTC-PERP", SUBJECT_B);
    const legacyValue = serializeGholaChartDrawingStorage(
      updateGholaChartDrawingRecord(
        emptyGholaChartDrawingStorage(),
        MAINNET,
        payload("legacy", 0),
        NOW,
      ),
      NOW,
    );
    storage.setItem(GHOLA_CHART_DRAWING_LEGACY_STORAGE_KEY, legacyValue);

    expect(persistGholaChartDrawingPayload(storage, accountA, payload("account-a", 0), candles(8), NOW)).toBe(true);
    expect(persistGholaChartDrawingPayload(storage, accountB, payload("account-b", 1), candles(8), NOW)).toBe(true);

    expect(gholaChartDrawingStorageKey(SUBJECT_A)).not.toBe(gholaChartDrawingStorageKey(SUBJECT_B));
    expect(gholaChartDrawingScope(accountA)).not.toBe(gholaChartDrawingScope(accountB));
    expect(loadGholaChartDrawingPayload(storage, accountA, candles(8), NOW)?.trendLines[0].id).toBe("account-a");
    expect(loadGholaChartDrawingPayload(storage, accountB, candles(8), NOW)?.trendLines[0].id).toBe("account-b");
    expect(storage.getItem(GHOLA_CHART_DRAWING_LEGACY_STORAGE_KEY)).toBe(legacyValue);
  });

  it("fails closed for missing or malformed persistence scopes", () => {
    expect(gholaChartDrawingStorageKey(null)).toBeNull();
    expect(gholaChartDrawingStorageKey("subject_short")).toBeNull();
    expect(gholaChartDrawingStorageKey(GHOLA_CHART_DRAWING_GUEST_SCOPE)).toBe(
      "ghola.chart-drawings.v2:device_guest",
    );
  });

  it("rejects malformed, non-finite, future, unsupported, and off-scope data", () => {
    const future = NOW + 60_000;
    const parsed = parseGholaChartDrawingStorage(JSON.stringify({
      version: 1,
      records: [{
        identity: MAINNET,
        updatedAt: NOW,
        anchoredVwap: { anchorTime: future, showBands: true },
        trendLines: [
          trend("valid", 0, 1),
          { ...trend("nonfinite", 1, 2), first: { time: START, price: null } },
          trend("future", 1, 145),
          { ...trend("bad-kind", 1, 2), kind: "infinite-ray" },
        ],
      }, {
        identity: { ...MAINNET, replayIdentityKey: "hyperliquid:mainnet:ETH:5m", product: "ETH-PERP" },
        updatedAt: future,
        anchoredVwap: null,
        trendLines: [trend("future-record", 0, 1)],
      }],
    }), NOW);

    expect(gholaChartDrawingRecordForIdentity(parsed, MAINNET)).toMatchObject({
      anchoredVwap: { anchorTime: future },
      trendLines: [{ id: "valid" }, { id: "future" }],
    });
    const scoped = gholaChartDrawingPayloadForCandles(
      gholaChartDrawingRecordForIdentity(parsed, MAINNET)!,
      candles(4),
    );
    expect(scoped).toMatchObject({ anchoredVwap: null, trendLines: [{ id: "valid" }] });
    expect(gholaChartDrawingRecordForIdentity(parsed, TESTNET)).toBeNull();
    expect(parseGholaChartDrawingStorage(JSON.stringify({ version: 99, records: [] }), NOW))
      .toEqual(emptyGholaChartDrawingStorage());
  });

  it("bounds records and trend drawings while keeping the newest identities and drawings", () => {
    let document = emptyGholaChartDrawingStorage();
    for (let recordIndex = 0; recordIndex < GHOLA_CHART_DRAWING_RECORD_LIMIT + 4; recordIndex += 1) {
      const trendLines = Array.from(
        { length: GHOLA_CHART_TREND_LINE_LIMIT + 3 },
        (_, drawingIndex) => trend(`r${recordIndex}-d${drawingIndex}`, drawingIndex, drawingIndex + 1),
      );
      document = updateGholaChartDrawingRecord(
        document,
        identity(`coinbase:mainnet:BTC:${recordIndex}`, "coinbase", `BTC-${recordIndex}`),
        { anchoredVwap: null, trendLines },
        NOW - 100 + recordIndex,
      );
    }

    expect(document.records).toHaveLength(GHOLA_CHART_DRAWING_RECORD_LIMIT);
    expect(document.records[0].identity.product).toBe(`BTC-${GHOLA_CHART_DRAWING_RECORD_LIMIT + 3}`);
    expect(document.records.every((record) => record.trendLines.length === GHOLA_CHART_TREND_LINE_LIMIT)).toBe(true);
    expect(document.records[0].trendLines[0].id).toBe(
      `r${GHOLA_CHART_DRAWING_RECORD_LIMIT + 3}-d3`,
    );
  });

  it("reveals only anchors and complete trend lines inside a replay candle prefix", () => {
    const full = payload("future-line", 1, 4);
    full.anchoredVwap = { anchorTime: candleTime(4), showBands: true };
    full.trendLines.unshift(trend("visible-line", 0, 2));

    const replay = gholaChartDrawingPayloadForCandles(full, candles(4));

    expect(replay.anchoredVwap).toBeNull();
    expect(replay.trendLines.map((drawing) => drawing.id)).toEqual(["visible-line"]);
    expect(full.anchoredVwap?.anchorTime).toBe(candleTime(4));
    expect(full.trendLines).toHaveLength(2);
  });

  it("normalizes seconds and microseconds to canonical frame timestamps", () => {
    const source = payload("normalized", 1, 2);
    source.anchoredVwap = { anchorTime: candleTime(1) / 1_000, showBands: false };
    source.trendLines[0].first.time = candleTime(1) / 1_000;
    source.trendLines[0].second.time = candleTime(2) * 1_000;

    expect(gholaChartDrawingPayloadForCandles(source, candles(4))).toEqual({
      anchoredVwap: { anchorTime: candleTime(1), showBands: false },
      trendLines: [{
        ...source.trendLines[0],
        first: { ...source.trendLines[0].first, time: candleTime(1) },
        second: { ...source.trendLines[0].second, time: candleTime(2) },
      }],
    });
  });

  it("persists a scoped clear tombstone and preserves sibling records", () => {
    let document = updateGholaChartDrawingRecord(
      emptyGholaChartDrawingStorage(),
      MAINNET,
      payload("main", 0),
      NOW - 1,
    );
    document = updateGholaChartDrawingRecord(document, TESTNET, payload("test", 1), NOW);
    document = updateGholaChartDrawingRecord(document, MAINNET, emptyGholaChartDrawingPayload(), NOW);

    expect(gholaChartDrawingRecordForIdentity(document, MAINNET)).toMatchObject({
      anchoredVwap: null,
      trendLines: [],
      updatedAt: NOW,
    });
    expect(gholaChartDrawingRecordForIdentity(document, TESTNET)?.trendLines[0].id).toBe("test");
  });

  it("merges concurrent sibling scopes without losing either tab's drawings", () => {
    const mainDocument = updateGholaChartDrawingRecord(
      emptyGholaChartDrawingStorage(), MAINNET, payload("main", 0), NOW - 1,
    );
    const testDocument = updateGholaChartDrawingRecord(
      emptyGholaChartDrawingStorage(), TESTNET, payload("test", 1), NOW,
    );

    const merged = mergeGholaChartDrawingStorage(mainDocument, testDocument, NOW);

    expect(gholaChartDrawingRecordForIdentity(merged, MAINNET)?.trendLines[0].id).toBe("main");
    expect(gholaChartDrawingRecordForIdentity(merged, TESTNET)?.trendLines[0].id).toBe("test");
  });

  it("resolves same-scope conflicts deterministically and lets an exact-time clear win", () => {
    const earlier = updateGholaChartDrawingRecord(
      emptyGholaChartDrawingStorage(), MAINNET, payload("earlier", 0), NOW - 1,
    );
    const later = updateGholaChartDrawingRecord(
      emptyGholaChartDrawingStorage(), MAINNET, payload("later", 1), NOW,
    );
    const cleared = updateGholaChartDrawingRecord(
      emptyGholaChartDrawingStorage(), MAINNET, emptyGholaChartDrawingPayload(), NOW,
    );

    expect(gholaChartDrawingRecordForIdentity(
      mergeGholaChartDrawingStorage(earlier, later, NOW), MAINNET,
    )?.trendLines[0].id).toBe("later");
    const clearedWinner = gholaChartDrawingRecordForIdentity(
      mergeGholaChartDrawingStorage(later, cleared, NOW), MAINNET,
    );
    expect(clearedWinner).toMatchObject({ anchoredVwap: null, trendLines: [] });
    expect(gholaChartDrawingPayloadEqual(clearedWinner!, emptyGholaChartDrawingPayload())).toBe(true);
  });

  it("distinguishes a sequential remote edit from divergent same-chart edits", () => {
    const base = updateGholaChartDrawingRecord(
      emptyGholaChartDrawingStorage(), MAINNET, payload("base", 0), NOW - 2,
    );
    const local = updateGholaChartDrawingRecord(base, MAINNET, payload("local", 1), NOW - 1);
    const remote = updateGholaChartDrawingRecord(base, MAINNET, payload("remote", 2), NOW);
    const previousValue = serializeGholaChartDrawingStorage(base, NOW);

    expect(gholaChartDrawingConcurrentScopeConflict({
      local: base, previousValue, incoming: remote, identity: MAINNET, nowMs: NOW,
    })).toBe(false);
    expect(gholaChartDrawingConcurrentScopeConflict({
      local, previousValue, incoming: remote, identity: MAINNET, nowMs: NOW,
    })).toBe(true);
  });

  it("does not call independent sibling-chart changes a conflict", () => {
    const base = updateGholaChartDrawingRecord(
      emptyGholaChartDrawingStorage(), MAINNET, payload("base", 0), NOW - 2,
    );
    const local = updateGholaChartDrawingRecord(base, MAINNET, payload("local", 1), NOW - 1);
    const sibling = updateGholaChartDrawingRecord(base, TESTNET, payload("test", 2), NOW);

    expect(gholaChartDrawingConcurrentScopeConflict({
      local,
      previousValue: serializeGholaChartDrawingStorage(base, NOW),
      incoming: sibling,
      identity: MAINNET,
      nowMs: NOW,
    })).toBe(false);
  });

  it("protects an unpersisted local same-chart edit from a remote overwrite", () => {
    const base = updateGholaChartDrawingRecord(
      emptyGholaChartDrawingStorage(), MAINNET, payload("base", 0), NOW - 1,
    );
    const remote = updateGholaChartDrawingRecord(base, MAINNET, payload("remote", 2), NOW);

    expect(gholaChartDrawingConcurrentScopeConflict({
      local: base,
      localPayload: payload("local-unpersisted", 1),
      previousValue: serializeGholaChartDrawingStorage(base, NOW),
      incoming: remote,
      identity: MAINNET,
      nowMs: NOW,
    })).toBe(true);
  });

  it("repairs a stale read-modify-write base while persisting a local edit", () => {
    const storage = memoryStorage();
    const mainDocument = updateGholaChartDrawingRecord(
      emptyGholaChartDrawingStorage(), MAINNET, payload("main", 0), NOW - 2,
    );
    expect(writeGholaChartDrawingPayload(
      storage, TESTNET, payload("test", 1), candles(8), null, NOW - 1,
    )).not.toBeNull();

    const repaired = writeGholaChartDrawingPayload(
      storage, MAINNET, payload("main-new", 2), candles(8), mainDocument, NOW,
    );

    expect(gholaChartDrawingRecordForIdentity(repaired!, MAINNET)?.trendLines[0].id).toBe("main-new");
    expect(gholaChartDrawingRecordForIdentity(repaired!, TESTNET)?.trendLines[0].id).toBe("test");
  });

  it("blocks a stale tab before it overwrites a newer same-chart revision", () => {
    const storage = memoryStorage();
    const base = updateGholaChartDrawingRecord(
      emptyGholaChartDrawingStorage(), MAINNET, payload("base", 0), NOW - 2,
    );
    storage.setItem(
      gholaChartDrawingStorageKey(MAINNET.persistenceScope)!,
      serializeGholaChartDrawingStorage(base, NOW),
    );
    const remote = writeGholaChartDrawingPayload(
      storage, MAINNET, payload("remote", 1), candles(8), base, NOW - 1,
    )!;

    const result = writeGholaChartDrawingPayloadGuarded({
      storage,
      identity: MAINNET,
      payload: payload("local", 2),
      candles: candles(8),
      baseStorage: base,
      nowMs: NOW,
    });

    expect(result.status).toBe("conflict");
    expect(loadGholaChartDrawingPayload(storage, MAINNET, candles(8), NOW)?.trendLines[0].id)
      .toBe("remote");
    expect(gholaChartDrawingRecordForIdentity(remote, MAINNET)?.trendLines[0].id).toBe("remote");
  });

  it("does not rewrite an unchanged hydrated scope", () => {
    const storage = memoryStorage();
    const base = updateGholaChartDrawingRecord(
      emptyGholaChartDrawingStorage(), MAINNET, payload("base", 0), NOW - 1,
    );
    const raw = serializeGholaChartDrawingStorage(base, NOW);
    storage.setItem(gholaChartDrawingStorageKey(MAINNET.persistenceScope)!, raw);

    const result = writeGholaChartDrawingPayloadGuarded({
      storage,
      identity: MAINNET,
      payload: payload("base", 0),
      candles: candles(8),
      baseStorage: base,
      nowMs: NOW,
    });

    expect(result.status).toBe("unchanged");
    expect(storage.getItem(gholaChartDrawingStorageKey(MAINNET.persistenceScope)!)).toBe(raw);
  });

  it("adopts a newer stored scope when this tab has no local divergence", () => {
    const storage = memoryStorage();
    const base = updateGholaChartDrawingRecord(
      emptyGholaChartDrawingStorage(), MAINNET, payload("base", 0), NOW - 2,
    );
    const remote = updateGholaChartDrawingRecord(base, MAINNET, payload("remote", 1), NOW - 1);
    const raw = serializeGholaChartDrawingStorage(remote, NOW);
    storage.setItem(gholaChartDrawingStorageKey(MAINNET.persistenceScope)!, raw);

    const result = writeGholaChartDrawingPayloadGuarded({
      storage,
      identity: MAINNET,
      payload: payload("base", 0),
      candles: candles(8),
      baseStorage: base,
      nowMs: NOW,
    });

    expect(result.status).toBe("stale");
    if (result.status !== "stale") return;
    expect(result.payload.trendLines[0].id).toBe("remote");
    expect(storage.getItem(gholaChartDrawingStorageKey(MAINNET.persistenceScope)!)).toBe(raw);
  });

  it("merges sibling-chart changes while guarding the active scope", () => {
    const storage = memoryStorage();
    const base = updateGholaChartDrawingRecord(
      emptyGholaChartDrawingStorage(), MAINNET, payload("main-base", 0), NOW - 2,
    );
    storage.setItem(
      gholaChartDrawingStorageKey(MAINNET.persistenceScope)!,
      serializeGholaChartDrawingStorage(base, NOW),
    );
    expect(writeGholaChartDrawingPayload(
      storage, TESTNET, payload("test", 1), candles(8), base, NOW - 1,
    )).not.toBeNull();

    const result = writeGholaChartDrawingPayloadGuarded({
      storage,
      identity: MAINNET,
      payload: payload("main-new", 2),
      candles: candles(8),
      baseStorage: base,
      nowMs: NOW,
    });

    expect(result.status).toBe("written");
    if (result.status !== "written") return;
    expect(gholaChartDrawingRecordForIdentity(result.document, MAINNET)?.trendLines[0].id).toBe("main-new");
    expect(gholaChartDrawingRecordForIdentity(result.document, TESTNET)?.trendLines[0].id).toBe("test");
  });

  it("preserves corrupt current storage instead of repairing it during an edit", () => {
    const storage = memoryStorage();
    const key = gholaChartDrawingStorageKey(MAINNET.persistenceScope)!;
    const raw = "{corrupt-concurrent-drawings";
    storage.setItem(key, raw);

    expect(writeGholaChartDrawingPayloadGuarded({
      storage,
      identity: MAINNET,
      payload: payload("local", 0),
      candles: candles(8),
      baseStorage: emptyGholaChartDrawingStorage(),
      nowMs: NOW,
    })).toEqual({ status: "blocked", document: null });
    expect(storage.getItem(key)).toBe(raw);
  });

  it("reconciles storage events without write loops and applies the winning scope", () => {
    const local = updateGholaChartDrawingRecord(
      emptyGholaChartDrawingStorage(), MAINNET, payload("local", 0), NOW - 2,
    );
    const sibling = updateGholaChartDrawingRecord(
      emptyGholaChartDrawingStorage(), TESTNET, payload("sibling", 1), NOW - 1,
    );
    const joined = reconcileGholaChartDrawingStorage({
      local,
      incomingValue: serializeGholaChartDrawingStorage(sibling, NOW),
      identity: MAINNET,
      candles: candles(8),
      nowMs: NOW,
    });
    expect(joined.repairRequired).toBe(true);
    expect(joined.payload.trendLines[0].id).toBe("local");
    expect(joined.document.records).toHaveLength(2);

    const remoteWinner = updateGholaChartDrawingRecord(
      emptyGholaChartDrawingStorage(), MAINNET, payload("remote", 2), NOW,
    );
    const adopted = reconcileGholaChartDrawingStorage({
      local,
      incomingValue: serializeGholaChartDrawingStorage(remoteWinner, NOW),
      identity: MAINNET,
      candles: candles(8),
      nowMs: NOW,
    });
    expect(adopted.repairRequired).toBe(false);
    expect(adopted.payload.trendLines[0].id).toBe("remote");

    const remoteClear = updateGholaChartDrawingRecord(
      emptyGholaChartDrawingStorage(), MAINNET, emptyGholaChartDrawingPayload(), NOW,
    );
    const cleared = reconcileGholaChartDrawingStorage({
      local,
      incomingValue: serializeGholaChartDrawingStorage(remoteClear, NOW),
      identity: MAINNET,
      candles: candles(8),
      nowMs: NOW,
    });
    expect(cleared.repairRequired).toBe(false);
    expect(cleared.payload).toEqual(emptyGholaChartDrawingPayload());
  });

  it("keeps denied localStorage reads and writes nonfatal", () => {
    const deniedRead: GholaChartDrawingStorageLike = {
      getItem() { throw new Error("denied"); },
      setItem() { throw new Error("denied"); },
    };
    const deniedWrite: GholaChartDrawingStorageLike = {
      getItem() { return null; },
      setItem() { throw new Error("quota"); },
    };

    expect(loadGholaChartDrawingPayload(deniedRead, MAINNET, candles(3), NOW)).toBeNull();
    expect(persistGholaChartDrawingPayload(deniedRead, MAINNET, payload("x", 0), candles(3), NOW)).toBe(false);
    expect(persistGholaChartDrawingPayload(deniedWrite, MAINNET, payload("x", 0), candles(3), NOW)).toBe(false);
  });
});

function identity(
  replayIdentityKey: string,
  venue: GholaChartDrawingIdentity["venue"] = "hyperliquid",
  product = "BTC-PERP",
  persistenceScope = GHOLA_CHART_DRAWING_GUEST_SCOPE,
): GholaChartDrawingIdentity {
  return { persistenceScope, replayIdentityKey, venue, product, interval: "5m" };
}

function payload(id: string, first: number, second = first + 1): GholaChartDrawingPayload {
  return {
    anchoredVwap: { anchorTime: candleTime(first), showBands: true },
    trendLines: [trend(id, first, second)],
  };
}

function trend(id: string, first: number, second: number) {
  return {
    id,
    kind: "segment" as const,
    first: { time: candleTime(first), price: 100 + first },
    second: { time: candleTime(second), price: 100 + second },
  };
}

function candles(length: number): GholaChartCandle[] {
  return Array.from({ length }, (_, index) => ({
    t: candleTime(index),
    T: candleTime(index + 1) - 1,
    o: "100",
    h: "101",
    l: "99",
    c: "100",
    v: "10",
    n: 1,
  }));
}

function candleTime(index: number) {
  return START + index * 5 * 60_000;
}

function memoryStorage(): GholaChartDrawingStorageLike {
  const values = new Map<string, string>();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
}

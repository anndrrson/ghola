import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listAllCarryPositionRecords } from "../src/execution/carry-record-scan.js";
import { createWorkerState } from "../src/state/private-state.js";

test("local durable state advances the composite scan cursor", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ghola-carry-scan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createWorkerState(dir);
  for (let index = 0; index < 5; index += 1) {
    const stored = await state.putCarryPositionRecord({
      owner_commitment: "owner:carry:scan",
      position: {
        position_id: `carry:position:${index}`,
        status: "active",
      },
    }, { expected_version: null });
    assert.equal(stored.ok, true);
  }

  const records = await listAllCarryPositionRecords({
    state,
    status: "active",
    page_size: 2,
  });

  assert.equal(records.length, 5);
  assert.equal(new Set(records.map((record) => record.position.position_id)).size, 5);
});

test("scans every Carry Position beyond the 500-record storage page", async () => {
  const rows = Array.from({ length: 1_201 }, (_, index) => ({
    owner_commitment: "owner:carry:scan",
    updated_at: new Date(1_800_000_000_000 - Math.floor(index / 3)).toISOString(),
    position: {
      position_id: `carry:position:${String(1_201 - index).padStart(5, "0")}`,
      status: "active",
    },
  })).sort(compareRecords);
  let calls = 0;
  const state = {
    listCarryPositionRecords: async (input) => {
      calls += 1;
      return rows
        .filter((record) => !input.before_updated_at
          || record.updated_at < input.before_updated_at
          || (record.updated_at === input.before_updated_at
            && record.position.position_id < input.before_position_id))
        .slice(0, input.limit);
    },
  };

  const records = await listAllCarryPositionRecords({ state, status: "active" });

  assert.equal(calls, 3);
  assert.equal(records.length, 1_201);
  assert.equal(new Set(records.map((record) => record.position.position_id)).size, 1_201);
  assert.deepEqual(records, rows);
});

test("fails closed when storage repeats a pagination cursor", async () => {
  const page = Array.from({ length: 500 }, (_, index) => ({
    updated_at: "2027-01-15T08:00:00.000Z",
    position: { position_id: `carry:position:${String(500 - index).padStart(5, "0")}` },
  }));
  await assert.rejects(
    listAllCarryPositionRecords({ state: { listCarryPositionRecords: async () => page } }),
    /carry_record_scan_cursor_invalid/,
  );
});

function compareRecords(left, right) {
  return right.updated_at.localeCompare(left.updated_at)
    || right.position.position_id.localeCompare(left.position.position_id);
}

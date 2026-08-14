import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

test("Hyperliquid runner proves accepted outcomes and rejects ambiguous responses", () => {
  const runnerPath = resolve("src/venues/hyperliquid_runner.py");
  const source = `
import contextlib
import importlib.util
import io
import json

spec = importlib.util.spec_from_file_location("hyperliquid_runner", ${JSON.stringify(runnerPath)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

resting = module.redact_result("submitted", {
    "status": "ok",
    "response": {"data": {"statuses": [{"resting": {"oid": 42}}]}},
}, "HYPE")
assert resting == {"status": "submitted", "oid": 42, "fills": []}

filled = module.redact_result("submitted", {
    "status": "ok",
    "response": {"data": {"statuses": [{"filled": {"oid": 43, "totalSz": "1", "avgPx": "10"}}]}},
}, "HYPE")
assert filled["status"] == "filled"
assert filled["oid"] == 43
assert filled["fills"][0]["sz"] == "1"

cancelled = module.redact_result("cancelled", {
    "status": "ok",
    "response": {"data": {"statuses": ["success"]}},
})
assert cancelled == {"status": "cancelled", "oid": None, "fills": []}

output = io.StringIO()
with contextlib.redirect_stdout(output):
    try:
        module.redact_result("submitted", {
            "status": "ok",
            "response": {"data": {"statuses": [{"error": "minimum order value"}]}},
        })
    except SystemExit:
        pass
failure = json.loads(output.getvalue())
assert failure["status"] == "failed"
assert failure["error_code"] == "venue_rejected"
assert "minimum order value" in failure["error"]
`;
  const result = spawnSync(process.env.PRIVATE_AGENT_PYTHON || "python3", ["-c", source], {
    cwd: resolve("."),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

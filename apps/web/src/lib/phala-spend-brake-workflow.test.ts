import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(process.cwd(), "../../.github/workflows/phala-spend-brake.yml"),
  "utf8",
);
const keepWarmWorkflow = readFileSync(
  resolve(process.cwd(), "../../.github/workflows/agent-keep-warm.yml"),
  "utf8",
);

describe("Phala spend-brake workflow", () => {
  it("uses the app CRON_SECRET bearer for scheduled idle checks", () => {
    expect(workflow).toContain("CRON_SECRET: ${{ secrets.CRON_SECRET }}");
    expect(workflow).toContain('curl -fsS -m 75 -X POST');
    expect(workflow).toContain('authorization: Bearer ${CRON_SECRET}');
    expect(workflow).toContain('if [ "${#CRON_SECRET}" -lt 32 ]');
    expect(workflow).not.toContain("x-vercel-cron");
  });

  it("fails closed on unknown idle checks and keeps manual runs dry-run-only", () => {
    expect(workflow).toContain("Idle checks were unknown or inconsistent; scheduled stop failed closed.");
    expect(workflow).toContain("Manual direct CVM stops are disabled");
    expect(workflow).toContain('args=(--names "$CVM_NAMES" --prefixes "$CVM_PREFIXES" --dry-run)');
    expect(workflow).toMatch(/uses: actions\/checkout@[0-9a-f]{40}/u);
    expect(workflow).toMatch(/uses: actions\/setup-node@[0-9a-f]{40}/u);
  });

  it("uses the same strong CRON_SECRET bearer for POST-only keep-warm", () => {
    expect(keepWarmWorkflow).toContain("CRON_SECRET: ${{ secrets.CRON_SECRET }}");
    expect(keepWarmWorkflow).toContain('if [ "${#CRON_SECRET}" -lt 32 ]');
    expect(keepWarmWorkflow).toContain("curl -s -o /tmp/body -w \"%{http_code}\" -X POST");
    expect(keepWarmWorkflow).not.toContain("KEEP_WARM_CRON_SECRET");
    expect(keepWarmWorkflow).not.toContain("x-vercel-cron");
  });
});

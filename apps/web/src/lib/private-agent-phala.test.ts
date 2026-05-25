import { describe, expect, it } from "vitest";
import {
  buildPhalaWorkerCompose,
  expectedRecipientReportDataHex,
} from "./private-agent-phala";

describe("private-agent Phala provisioning", () => {
  it("builds a no-plaintext worker compose with dstack quote binding", () => {
    const compose = buildPhalaWorkerCompose({
      image: "ghcr.io/example/worker@sha256:abc",
      imageDigest: "sha256:abc",
    });

    expect(compose).toContain("ghcr.io/example/worker@sha256:abc");
    expect(compose).toContain("/var/run/dstack.sock:/var/run/dstack.sock");
    expect(compose).toContain('PRIVATE_AGENT_REQUIRE_DSTACK_QUOTE: "true"');
    expect(compose).toContain(
      'PRIVATE_AGENT_EXECUTION_TOKEN: "${PRIVATE_AGENT_EXECUTION_TOKEN}"',
    );
    expect(compose).not.toMatch(/PHALA_CLOUD_API_KEY|PHALA_API_KEY/);
    expect(compose).not.toMatch(/prompt|strategy_text|messages|policy:/i);
  });

  it("binds recipient evidence to recipient id and public key", () => {
    const first = expectedRecipientReportDataHex({
      recipientId: "phala:cvm:one",
      x25519PubHex: "11".repeat(32),
    });
    const second = expectedRecipientReportDataHex({
      recipientId: "phala:cvm:two",
      x25519PubHex: "11".repeat(32),
    });

    expect(first).toMatch(/^0x[0-9a-f]{64}$/);
    expect(second).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  buildPhalaWorkerCompose,
  ensurePhalaWorkerComposeCurrent,
} from "./private-agent-phala";

type FakeClient = {
  getCvmInfo: ReturnType<typeof vi.fn>;
  getCvmNetwork: ReturnType<typeof vi.fn>;
  getCvmAttestation: ReturnType<typeof vi.fn>;
  getCvmState: ReturnType<typeof vi.fn>;
  getCvmComposeFile: ReturnType<typeof vi.fn>;
  startCvm: ReturnType<typeof vi.fn>;
  stopCvm: ReturnType<typeof vi.fn>;
  provisionCvm: ReturnType<typeof vi.fn>;
  commitCvmProvision: ReturnType<typeof vi.fn>;
  provisionCvmComposeFileUpdate: ReturnType<typeof vi.fn>;
  commitCvmComposeFileUpdate: ReturnType<typeof vi.fn>;
};

type DriftClient = Parameters<typeof ensurePhalaWorkerComposeCurrent>[0];

function fakeClient(overrides: Partial<FakeClient> = {}): FakeClient & DriftClient {
  return {
    getCvmInfo: vi.fn(),
    getCvmNetwork: vi.fn(),
    getCvmAttestation: vi.fn(),
    getCvmState: vi.fn(),
    getCvmComposeFile: vi.fn(),
    startCvm: vi.fn(),
    stopCvm: vi.fn(),
    provisionCvm: vi.fn(),
    commitCvmProvision: vi.fn(),
    provisionCvmComposeFileUpdate: vi.fn(),
    commitCvmComposeFileUpdate: vi.fn(),
    ...overrides,
  } as FakeClient & DriftClient;
}

describe("ensurePhalaWorkerComposeCurrent", () => {
  it("does not update when the stored compose matches what we would provision today", async () => {
    const client = fakeClient({
      getCvmComposeFile: vi.fn().mockResolvedValue({
        docker_compose_file: buildPhalaWorkerCompose(),
      }),
    });
    const result = await ensurePhalaWorkerComposeCurrent(client, "cvm-test", "token");
    expect(result).toEqual({ checked: true, updated: false, reason: null });
    expect(client.provisionCvmComposeFileUpdate).not.toHaveBeenCalled();
    expect(client.commitCvmComposeFileUpdate).not.toHaveBeenCalled();
  });

  it("tolerates trailing-whitespace differences without updating", async () => {
    const stored = buildPhalaWorkerCompose()
      .split("\n")
      .map((line) => `${line}  `)
      .join("\n");
    const client = fakeClient({
      getCvmComposeFile: vi.fn().mockResolvedValue({ docker_compose_file: stored }),
    });
    const result = await ensurePhalaWorkerComposeCurrent(client, "cvm-test", "token");
    expect(result.updated).toBe(false);
    expect(client.provisionCvmComposeFileUpdate).not.toHaveBeenCalled();
  });

  it("provisions and commits a compose update when the stored compose drifted", async () => {
    const client = fakeClient({
      getCvmComposeFile: vi.fn().mockResolvedValue({
        name: "ghola-private-agent-worker",
        manifest_version: 2,
        kms_enabled: true,
        docker_compose_file: 'services:\n  worker:\n    environment:\n      PRIVATE_AGENT_HYPERLIQUID_FULL_TICKET_MAX_NOTIONAL_USD: ""\n',
      }),
      provisionCvmComposeFileUpdate: vi.fn().mockResolvedValue({ compose_hash: "hash123" }),
      commitCvmComposeFileUpdate: vi.fn().mockResolvedValue(undefined),
    });
    const result = await ensurePhalaWorkerComposeCurrent(client, "cvm-test", "token");
    expect(result).toEqual({ checked: true, updated: true, reason: null });

    const provisionArgs = client.provisionCvmComposeFileUpdate.mock.calls[0][0];
    expect(provisionArgs.id).toBe("cvm-test");
    expect(provisionArgs.app_compose.docker_compose_file).toBe(buildPhalaWorkerCompose());
    expect(provisionArgs.app_compose.allowed_envs).toContain("PRIVATE_AGENT_EXECUTION_TOKEN");
    // Server-required fields from the stored compose are passed through.
    expect(provisionArgs.app_compose.name).toBe("ghola-private-agent-worker");
    expect(provisionArgs.app_compose.manifest_version).toBe(2);
    expect(provisionArgs.app_compose.kms_enabled).toBe(true);

    const commitArgs = client.commitCvmComposeFileUpdate.mock.calls[0][0];
    expect(commitArgs).toMatchObject({
      id: "cvm-test",
      compose_hash: "hash123",
      update_env_vars: false,
    });
  });

  it("fails open when the compose cannot be fetched", async () => {
    const client = fakeClient({
      getCvmComposeFile: vi.fn().mockRejectedValue(new Error("network")),
    });
    const result = await ensurePhalaWorkerComposeCurrent(client, "cvm-test", "token");
    expect(result).toEqual({ checked: false, updated: false, reason: "compose_fetch_failed" });
    expect(client.provisionCvmComposeFileUpdate).not.toHaveBeenCalled();
  });

  it("reports failure without committing when provision returns no compose hash", async () => {
    const client = fakeClient({
      getCvmComposeFile: vi.fn().mockResolvedValue({ docker_compose_file: "services: {}" }),
      provisionCvmComposeFileUpdate: vi.fn().mockResolvedValue({}),
    });
    const result = await ensurePhalaWorkerComposeCurrent(client, "cvm-test", "token");
    expect(result.updated).toBe(false);
    expect(result.reason).toBe("compose_update_provision_failed");
    expect(client.commitCvmComposeFileUpdate).not.toHaveBeenCalled();
  });
});

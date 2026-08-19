import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cloud = vi.hoisted(() => ({
  client: {
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
  },
  createClient: vi.fn(),
  encryptEnvVars: vi.fn(),
}));

vi.mock("@phala/cloud", () => ({
  createClient: cloud.createClient,
  encryptEnvVars: cloud.encryptEnvVars,
}));

vi.mock("./private-agent-spend-policy", () => ({
  privateAgentEnvironment: () => "production",
  privateAgentSpendPolicy: (action: string) => ({
    allowed: true,
    action,
    environment: "production",
  }),
}));

import { wakePhalaPrivateAgentForUse } from "./private-agent-phala";
import { resetPrivateAgentRuntimeLeaseStoreForTests } from "./private-agent-runtime-lease";

const ORIGINAL_ENV = { ...process.env };
const CVM_NAME = "ghola-private-agent-worker";

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "worker-token",
    GHOLA_PRIVATE_AGENT_LEASE_STORE: "memory",
    GHOLA_PRIVATE_AGENT_PROVISIONING_MUTATIONS_ENABLED: "true",
    GHOLA_PRIVATE_AGENT_SPEND_ARMED: "true",
    GHOLA_PRIVATE_AGENT_WAKE_ON_USE_ENABLED: "true",
    PHALA_CLOUD_API_KEY: "phala-key",
  };
  for (const mock of Object.values(cloud.client)) mock.mockReset();
  cloud.createClient.mockReset().mockReturnValue(cloud.client);
  cloud.encryptEnvVars.mockReset().mockResolvedValue("encrypted-env");
  cloud.client.getCvmNetwork.mockResolvedValue(null);
  cloud.client.getCvmAttestation.mockResolvedValue(null);
  resetPrivateAgentRuntimeLeaseStoreForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetPrivateAgentRuntimeLeaseStoreForTests();
});

describe("ordinary Phala wake mutation boundary", () => {
  it("repeatedly inspects and may start the exact CVM without release mutations", async () => {
    cloud.client.getCvmInfo.mockResolvedValue({
      id: "cvm-existing",
      name: CVM_NAME,
      status: "stopped",
    });
    cloud.client.getCvmState
      .mockResolvedValueOnce({ status: "stopped" })
      .mockResolvedValue({ status: "running" });
    cloud.client.startCvm.mockResolvedValue(undefined);

    const first = await wakePhalaPrivateAgentForUse({ reason: "ordinary_user_wake" });
    const second = await wakePhalaPrivateAgentForUse({ reason: "ordinary_user_wake_again" });

    expect(first).toMatchObject({ attempted: true, ready: false, status: "provisioning" });
    expect(second).toMatchObject({ attempted: false, ready: false, status: "provisioning" });
    expect(cloud.client.startCvm).toHaveBeenCalledTimes(1);
    expect(cloud.client.startCvm).toHaveBeenCalledWith({ id: CVM_NAME });
    expect(cloud.client.getCvmComposeFile).not.toHaveBeenCalled();
    expect(cloud.client.provisionCvm).not.toHaveBeenCalled();
    expect(cloud.client.commitCvmProvision).not.toHaveBeenCalled();
    expect(cloud.client.provisionCvmComposeFileUpdate).not.toHaveBeenCalled();
    expect(cloud.client.commitCvmComposeFileUpdate).not.toHaveBeenCalled();
    expect(cloud.encryptEnvVars).not.toHaveBeenCalled();
  });

  it("fails closed on a missing CVM without provisioning", async () => {
    cloud.client.getCvmInfo.mockRejectedValue(
      Object.assign(new Error("not found"), { status: 404 }),
    );

    const result = await wakePhalaPrivateAgentForUse({ reason: "ordinary_missing_wake" });

    expect(result).toMatchObject({
      attempted: false,
      ready: false,
      status: "missing_cvm",
    });
    expect(cloud.client.startCvm).not.toHaveBeenCalled();
    expect(cloud.client.provisionCvm).not.toHaveBeenCalled();
    expect(cloud.client.commitCvmProvision).not.toHaveBeenCalled();
    expect(cloud.client.provisionCvmComposeFileUpdate).not.toHaveBeenCalled();
    expect(cloud.client.commitCvmComposeFileUpdate).not.toHaveBeenCalled();
  });

  it("does not interpret a transient lookup failure as permission to provision", async () => {
    cloud.client.getCvmInfo.mockRejectedValue(new Error("upstream timeout"));

    const result = await wakePhalaPrivateAgentForUse({ reason: "ordinary_transient_failure" });

    expect(result).toMatchObject({ attempted: false, ready: false, status: "failed" });
    expect(cloud.client.provisionCvm).not.toHaveBeenCalled();
    expect(cloud.client.commitCvmProvision).not.toHaveBeenCalled();
  });
});

import { sleep } from "workflow";
import { stopExpiredPhalaPrivateAgent } from "./steps";

export interface PrivateAgentIdleShutdownInput {
  provider_id: "phala";
  lease_expires_at: string;
}

export async function privateAgentIdleShutdownWorkflow(
  input: PrivateAgentIdleShutdownInput,
) {
  "use workflow";

  await sleep(new Date(input.lease_expires_at));
  return stopExpiredPhalaPrivateAgent(input.provider_id);
}

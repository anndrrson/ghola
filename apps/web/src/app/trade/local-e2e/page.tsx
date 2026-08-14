import { notFound } from "next/navigation";
import { LocalExecutionE2E } from "./LocalExecutionE2E";

export default function LocalExecutionE2EPage() {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.GHOLA_PRIVATE_AGENT_LOCAL_E2E_ENABLED !== "true" ||
    process.env.GHOLA_PRIVATE_AGENT_LOCAL_E2E_DRY_RUN !== "true"
  ) notFound();
  const claimStore = process.env.GHOLA_PRIVATE_AGENT_LOCAL_E2E_CLAIM_STORE === "postgres"
    ? "Postgres" as const
    : "SQLite" as const;
  return <LocalExecutionE2E claimStore={claimStore} />;
}

import assert from "node:assert/strict";
import test from "node:test";
import { verifyVercelWebStatus, VERCEL_WEB_CONTEXT } from "./verify-vercel-web-status.mjs";

const completed = {
  context: VERCEL_WEB_CONTEXT,
  state: "success",
  description: "Deployment has completed",
  targetUrl: "https://vercel.com/example/web/deployment-id",
  sha: "81bb796b",
};

test("accepts only a completed Vercel web deployment", () => {
  assert.deepEqual(verifyVercelWebStatus(completed), {
    context: VERCEL_WEB_CONTEXT,
    state: "success",
    description: "Deployment has completed",
    target_url: completed.targetUrl,
    sha: completed.sha,
  });
});

test("rejects Vercel's green canceled-by-ignore result", () => {
  assert.throws(
    () => verifyVercelWebStatus({
      ...completed,
      description: "Canceled by Ignored Build Step",
    }),
    /was not built/,
  );
});

test("rejects non-success and incomplete status events", () => {
  assert.throws(
    () => verifyVercelWebStatus({ ...completed, state: "failure" }),
    /not successful/,
  );
  assert.throws(
    () => verifyVercelWebStatus({ ...completed, description: "Checks passed" }),
    /not a completed deployment/,
  );
});

test("requires the exact web context, deployment URL, and commit SHA", () => {
  assert.throws(
    () => verifyVercelWebStatus({ ...completed, context: "Vercel – repo" }),
    /unexpected Vercel status context/,
  );
  assert.throws(
    () => verifyVercelWebStatus({ ...completed, targetUrl: "" }),
    /missing its deployment target URL/,
  );
  assert.throws(
    () => verifyVercelWebStatus({ ...completed, sha: "not-a-sha" }),
    /valid commit SHA/,
  );
});

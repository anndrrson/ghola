import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowsSerializedOwnerTransaction,
  isPrivateAccountLiveMutationPath,
} from "./private-account-live-routes";

const ROUTES_ROOT = resolve(process.cwd(), "src/app/v1/private-account");

describe("private-account live routes", () => {
  it("keeps every live-guarded route reachable through the server proof proxy", () => {
    const guardedRoutes = routeFiles(ROUTES_ROOT)
      .filter((file) => readFileSync(file, "utf8").includes("privateAccountLiveGuard("))
      .map(routePathname);

    expect(guardedRoutes.length).toBeGreaterThan(0);
    expect(guardedRoutes.filter((pathname) => !isPrivateAccountLiveMutationPath(pathname))).toEqual([]);
  });

  it("allows a serialized owner transaction only for Lighter completion", () => {
    expect(allowsSerializedOwnerTransaction("/v1/private-account/platforms/lighter/complete")).toBe(true);
    expect(allowsSerializedOwnerTransaction("/v1/private-account/platforms/lighter/recovery/prepare")).toBe(false);
    expect(allowsSerializedOwnerTransaction("/v1/private-account/platforms/aster/complete")).toBe(false);
  });

  it("allows only the no-submit Lighter recovery preparation endpoint", () => {
    expect(isPrivateAccountLiveMutationPath("/v1/private-account/platforms/lighter/recovery/prepare")).toBe(true);
    expect(isPrivateAccountLiveMutationPath("/v1/private-account/platforms/lighter/recovery/complete")).toBe(false);
    expect(isPrivateAccountLiveMutationPath("/v1/private-account/platforms/lighter/recovery/submit")).toBe(false);
  });
});

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  });
}

function routePathname(file: string): string {
  const relative = file
    .slice(ROUTES_ROOT.length)
    .replace(/\/route\.ts$/, "")
    .replace(/\[[^\]]+\]/g, "test-segment");
  return `/v1/private-account${relative}`;
}

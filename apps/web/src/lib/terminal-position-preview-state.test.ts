import { describe, expect, it } from "vitest";
import {
  terminalPositionPreviewStatus,
  terminalPositionPreviewStatusCopy,
} from "./terminal-position-preview-state";

describe("terminal position preview state", () => {
  it.each([
    ["idle", "planned"],
    ["error", "planned"],
    ["done", "acknowledged"],
    ["unknown", "unknown"],
  ] as const)("maps %s execution to %s position semantics", (execution, expected) => {
    expect(terminalPositionPreviewStatus(execution)).toBe(expected);
  });

  it("distinguishes pre-dispatch preparation from an in-flight submit", () => {
    expect(terminalPositionPreviewStatus("working", "session")).toBe("preparing");
    expect(terminalPositionPreviewStatus("working", "linking")).toBe("preparing");
    expect(terminalPositionPreviewStatus("working", "submitting")).toBe("submitting");
  });

  it("never calls an acknowledgement a fill or an unknown outcome merely planned", () => {
    expect(terminalPositionPreviewStatusCopy("acknowledged").label).toBe("acknowledged · fill unverified");
    expect(terminalPositionPreviewStatusCopy("unknown")).toMatchObject({ label: "outcome unknown", tone: "danger" });
  });
});

import { describe, it, expect } from "vitest";
import { detectAction } from "./detect-action";

describe("detectAction (regex fallback)", () => {
  it("returns undefined when nothing matches", () => {
    expect(detectAction("Hi, how can I help?")).toBeUndefined();
    expect(detectAction("")).toBeUndefined();
  });

  it("detects email with explicit subject", () => {
    const action = detectAction(
      "I'll send an email to alice@example.com subject: Demo follow-up",
    );
    expect(action?.type).toBe("email");
    expect(action?.data.to).toBe("alice@example.com");
    expect(action?.data.subject).toBe("Demo follow-up");
  });

  it("detects email without a subject, falls back to default", () => {
    const action = detectAction("I'll draft to bob@example.com about the meeting");
    expect(action?.type).toBe("email");
    expect(action?.data.to).toBe("bob@example.com");
    expect(action?.data.subject).toBe("Message from ghola");
  });

  it("detects call with digit-only phone", () => {
    const action = detectAction("Sure, I'll call 5551234567 to confirm.");
    expect(action?.type).toBe("call");
    expect(action?.data.phone_number).toBe("5551234567");
  });

  it("detects call with formatted phone", () => {
    const action = detectAction("I'll call them at +1 (555) 123-4567 right now.");
    expect(action?.type).toBe("call");
    expect(String(action?.data.phone_number)).toContain("555");
  });

  it("prefers call over email when both could match (call regex runs first)", () => {
    const action = detectAction(
      "I'll call 5551234567 and email bob@example.com after",
    );
    expect(action?.type).toBe("call");
  });
});

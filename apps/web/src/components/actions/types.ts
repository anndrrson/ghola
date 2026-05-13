import type { ThumperInlineAction } from "@/lib/thumper-types";

export type ActionKind = "email" | "sms" | "call" | "calendar";

export type ActionDraft =
  | { kind: "email"; to: string; subject: string; body: string }
  | { kind: "sms"; to: string; body: string }
  | { kind: "call"; phone_number: string; objective: string }
  | {
      kind: "calendar";
      title: string;
      start: string;
      end: string;
      description?: string;
      location?: string;
      timezone?: string;
    };

function s(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return fallback;
  return String(v);
}

function optS(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

export function mapInlineActionToDraft(a: ThumperInlineAction): ActionDraft | null {
  switch (a.type) {
    case "email":
      return {
        kind: "email",
        to: s(a.data.to),
        subject: s(a.data.subject),
        body: s(a.data.body),
      };
    case "sms":
      return {
        kind: "sms",
        to: s(a.data.to),
        body: s(a.data.body),
      };
    case "call":
      return {
        kind: "call",
        phone_number: s(a.data.phone_number ?? a.data.phone),
        objective: s(a.data.objective),
      };
    case "calendar":
      return {
        kind: "calendar",
        title: s(a.data.title),
        start: s(a.data.start),
        end: s(a.data.end),
        description: optS(a.data.description),
        location: optS(a.data.location),
        timezone: optS(a.data.timezone),
      };
    case "task":
      // Task actions render via TaskCard, not ActionCard.
      return null;
  }
}

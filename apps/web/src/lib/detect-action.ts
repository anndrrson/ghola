import type { ThumperInlineAction } from "./thumper-types";

/**
 * Regex-based fallback for surfacing an action card from the assistant's
 * plain-text reply. The cloud's preferred path is structured tool-call
 * proposals (`event: action_proposal` over SSE) which arrive via
 * `streamChat.onActionProposal`; this function only runs when the proposal
 * stream produced nothing — typically because the user's model is a
 * community-GPU provider that doesn't support tool-use.
 */
export function detectAction(text: string): ThumperInlineAction | undefined {
  // Detect call suggestions
  const callMatch = text.match(
    /(?:call|phone|dial|ring)\s+(?:.*?)\s*(?:at\s+)?(\+?[\d\s()-]{7,})/i,
  );
  if (callMatch) {
    const phone = callMatch[1].trim();
    const objective = text.length > 200 ? text.slice(0, 200) + "..." : text;
    return {
      type: "call",
      status: "ready",
      data: { phone_number: phone, objective },
    };
  }

  // Detect email suggestions
  const emailMatch = text.match(
    /(?:email|send|write|draft)\s+(?:an?\s+)?(?:email\s+)?(?:to\s+)?([^\s,]+@[^\s,]+)/i,
  );
  if (emailMatch) {
    const to = emailMatch[1];
    const subjectMatch = text.match(/subject[:\s]+["']?([^"'\n]+)/i);
    const subject = subjectMatch ? subjectMatch[1].trim() : "Message from ghola";
    return {
      type: "email",
      status: "ready",
      data: { to, subject, body: "" },
    };
  }

  return undefined;
}

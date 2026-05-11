//! Proposal-only tool definitions for chat-driven actions.
//!
//! These tools are surfaced to the LLM during chat. When the model picks one,
//! the cloud does NOT execute the action — it streams the proposed args back
//! to the client as an `action_proposal` SSE event, and the web client renders
//! an `ActionCard` pre-filled with those args. The user reviews/edits and
//! clicks Send, which hits the corresponding HTTP route directly.
//!
//! Naming convention: tool names start with `propose_` so the llm_router can
//! short-circuit and treat them as terminal (no execute_tool dispatch, no
//! loop continuation). See `is_proposal_tool` in `llm_router.rs`.

pub fn action_tool_definitions() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({
            "name": "propose_email",
            "description": "Propose an email to the user for review. Call this when the user wants to send an email. The user will review the draft and confirm before it is sent.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "to": { "type": "string", "description": "Recipient email address" },
                    "subject": { "type": "string", "description": "Email subject line" },
                    "body": { "type": "string", "description": "Email body" }
                },
                "required": ["to", "subject", "body"]
            }
        }),
        serde_json::json!({
            "name": "propose_sms",
            "description": "Propose a text message (SMS) to the user for review. Call this when the user wants to send a text. The user will review and confirm before it is sent.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "to": { "type": "string", "description": "Recipient phone number in E.164 format (e.g. +15551234567)" },
                    "body": { "type": "string", "description": "Message body (keep under 160 characters when possible)" }
                },
                "required": ["to", "body"]
            }
        }),
        serde_json::json!({
            "name": "propose_call",
            "description": "Propose an AI phone call to the user for review. Call this when the user wants to call someone (book a reservation, follow up, etc.). The user will review the objective and confirm before the call is placed.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "phone_number": { "type": "string", "description": "Phone number to call in E.164 format (e.g. +15551234567)" },
                    "objective": { "type": "string", "description": "What the call should accomplish (e.g. 'book a table for 4 at 7pm tomorrow')" }
                },
                "required": ["phone_number", "objective"]
            }
        }),
        serde_json::json!({
            "name": "propose_calendar_event",
            "description": "Propose a calendar event to the user for review. Call this when the user wants to schedule something. The user will review and confirm before the event is created on their Google Calendar.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Event title" },
                    "start": { "type": "string", "description": "Start time as RFC3339 (e.g. '2026-05-12T14:00:00-05:00')" },
                    "end": { "type": "string", "description": "End time as RFC3339" },
                    "description": { "type": "string", "description": "Optional event description" },
                    "location": { "type": "string", "description": "Optional event location" },
                    "timezone": { "type": "string", "description": "IANA timezone (defaults to America/New_York)" }
                },
                "required": ["title", "start", "end"]
            }
        }),
    ]
}

/// True for tool names that should terminate the tool-use loop without
/// executing — the cloud emits the proposed args and the client renders a
/// review card.
pub fn is_proposal_tool(name: &str) -> bool {
    name.starts_with("propose_")
}

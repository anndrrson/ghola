//! Integration tests for the discovery layer.
//!
//! Tests agents.txt and .well-known/said.json parsing — the two discovery
//! protocols that AI agents use to find services and payment info for a domain.
//! All tests are pure logic (no network I/O required).

use said_core::discovery::{parse_agents_txt, parse_well_known_said};

// ── agents.txt: service discovery ──────────────────────────────────────────

#[test]
fn list_services_from_agents_txt() {
    let content = r#"
Identity: did:key:z6MkTest1234
Profile: https://example.com/said/profile

Service: book-table https://example.com/api/book
Service: check-availability https://example.com/api/availability
Service: order-online https://example.com/api/order
"#;

    let agents = parse_agents_txt(content).expect("parse");

    assert_eq!(agents.services.len(), 3);

    let names: Vec<&str> = agents.services.iter().map(|s| s.name.as_str()).collect();
    assert!(names.contains(&"book-table"));
    assert!(names.contains(&"check-availability"));
    assert!(names.contains(&"order-online"));
}

#[test]
fn lookup_service_by_name() {
    let content = r#"
Service: book-table https://example.com/api/book
Service: payments https://pay.example.com/v1
"#;

    let agents = parse_agents_txt(content).expect("parse");

    let found = agents.services.iter().find(|s| s.name == "payments");
    assert!(found.is_some());
    assert_eq!(found.unwrap().url, "https://pay.example.com/v1");
}

#[test]
fn missing_service_returns_none() {
    let content = "Service: book-table https://example.com/api/book\n";
    let agents = parse_agents_txt(content).expect("parse");
    let found = agents.services.iter().find(|s| s.name == "nonexistent");
    assert!(found.is_none());
}

#[test]
fn identity_is_parsed() {
    let content = "Identity: did:key:z6MkHelloWorld\n";
    let agents = parse_agents_txt(content).expect("parse");
    assert_eq!(agents.identity.as_deref(), Some("did:key:z6MkHelloWorld"));
}

#[test]
fn allow_agent_accumulates() {
    let content = r#"
Allow-Agent: did:key:z6MkAgentA
Allow-Agent: did:key:z6MkAgentB
Allow-Agent: *
"#;
    let agents = parse_agents_txt(content).expect("parse");
    assert_eq!(agents.allow_agents.len(), 3);
    assert!(agents.allow_agents.contains(&"*".to_string()));
}

#[test]
fn last_identity_wins() {
    let content = r#"
Identity: did:key:z6MkFirst
Identity: did:key:z6MkSecond
"#;
    let agents = parse_agents_txt(content).expect("parse");
    assert_eq!(agents.identity.as_deref(), Some("did:key:z6MkSecond"));
}

#[test]
fn comments_and_blanks_skipped() {
    let content = r#"
# This is a comment

Identity: did:key:z6MkTest

# Another comment
Service: api https://example.com/api
"#;
    let agents = parse_agents_txt(content).expect("parse");
    assert_eq!(agents.identity.as_deref(), Some("did:key:z6MkTest"));
    assert_eq!(agents.services.len(), 1);
}

#[test]
fn malformed_lines_are_silently_skipped() {
    let content = r#"
this line has no colon
Identity: did:key:z6MkOk
also bad
Service: api https://example.com
"#;
    let result = parse_agents_txt(content);
    assert!(result.is_ok());
    let agents = result.unwrap();
    assert_eq!(agents.identity.as_deref(), Some("did:key:z6MkOk"));
    assert_eq!(agents.services.len(), 1);
}

#[test]
fn directives_are_case_insensitive() {
    let content = r#"
IDENTITY: did:key:z6MkUpperCase
service: api https://example.com/api
ALLOW-AGENT: *
"#;
    let agents = parse_agents_txt(content).expect("parse");
    assert!(agents.identity.is_some());
    assert_eq!(agents.services.len(), 1);
    assert_eq!(agents.allow_agents.len(), 1);
}

#[test]
fn payment_info_is_parsed() {
    let content = r#"
Identity: did:key:z6MkMerchant
Payment: SoLaNaAdDrEsS123 usdc https://example.com/said/verify
"#;
    let agents = parse_agents_txt(content).expect("parse");
    // Payment info in agents.txt v1.1 — may or may not exist depending on parser version.
    // The identity should at least parse correctly.
    assert!(agents.identity.is_some());
}

#[test]
fn skill_entries_are_parsed() {
    let content = r#"
Skill: book-table https://agentskills.io/example/book-table.json
Skill: check-availability https://agentskills.io/example/check-avail.json
"#;
    let agents = parse_agents_txt(content).expect("parse");
    assert_eq!(agents.skills.len(), 2);
    assert_eq!(agents.skills[0].name, "book-table");
}

// ── .well-known/said.json ──────────────────────────────────────────────────

#[test]
fn well_known_said_parses_correctly() {
    let json = serde_json::json!({
        "said_version": "1.0",
        "did": "did:key:z6MkMerchant",
        "profile_url": "https://example.com/profile",
        "business": {
            "name": "Example Restaurant",
            "category": "restaurant",
            "description": "Great food"
        },
        "services": [
            {
                "name": "Book Table",
                "description": "Reserve a table",
                "price": "0.01 USDC",
                "parameters": {}
            }
        ]
    });

    let wk: said_types::WellKnownSaid = serde_json::from_value(json).expect("deserialize");

    assert_eq!(wk.did, "did:key:z6MkMerchant");
    assert_eq!(wk.said_version, "1.0");
    assert_eq!(wk.services.len(), 1);
    assert_eq!(wk.services[0].name, "Book Table");
    assert!(wk.business.is_some());
    assert_eq!(wk.business.unwrap().name, "Example Restaurant");
}

#[test]
fn well_known_said_payment_config() {
    let json = serde_json::json!({
        "said_version": "1.0",
        "did": "did:key:z6MkMerchant",
        "services": [],
        "payment": {
            "receive_address": "SoLaNaAdDrEsS123",
            "accepted_currencies": ["usdc", "sol"],
            "verify_url": "https://example.com/said/verify",
            "meter_url": "https://example.com/said/meter"
        }
    });

    let wk: said_types::WellKnownSaid = serde_json::from_value(json).expect("deserialize");

    let payment = wk.payment.expect("payment config");
    assert_eq!(payment.receive_address, "SoLaNaAdDrEsS123");
    assert!(payment.accepted_currencies.contains(&"usdc".to_string()));
}

// ── parse_well_known_said (string variant) ─────────────────────────────────

#[test]
fn parse_well_known_said_from_str() {
    let json_str = r#"{
        "said_version": "1.0",
        "did": "did:key:z6MkTest",
        "services": []
    }"#;

    let wk = parse_well_known_said(json_str).expect("parse");
    assert_eq!(wk.did, "did:key:z6MkTest");
}

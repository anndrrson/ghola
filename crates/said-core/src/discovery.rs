//! Discovery module for agents.txt parsing, .well-known/said.json parsing,
//! domain fetching, and domain verification.

use said_types::{AgentsTxt, AgentsTxtAuth, AgentsTxtService, WellKnownSaid};
use serde::Serialize;

// ── Error Type ──

#[derive(Debug, thiserror::Error)]
pub enum DiscoveryError {
    #[error("Parse error: {0}")]
    Parse(String),
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Verification failed: {0}")]
    VerificationFailed(String),
}

// ── Domain Discovery Result ──

/// Combined result of discovering agents.txt and .well-known/said.json for a domain.
#[derive(Clone, Debug, Serialize)]
pub struct DomainDiscovery {
    pub domain: String,
    pub agents_txt: Option<AgentsTxt>,
    pub well_known: Option<WellKnownSaid>,
}

// ── Parsing Functions ──

/// Parse the contents of an agents.txt file into an `AgentsTxt` struct.
///
/// Parsing rules:
/// - Lines starting with `#` are comments (skipped).
/// - Empty/whitespace-only lines are skipped.
/// - Directive format: `Key: value` (key is case-insensitive).
/// - Known directives: Identity, Profile, Said-Json, Allow-Agent, Service, Auth.
/// - Service format: `Service: <name> <url>` (space-separated).
/// - Auth format: `Auth: <method> <url>`.
/// - Unknown directives are silently skipped.
/// - For Identity/Profile/Said-Json: last occurrence wins.
/// - For Allow-Agent/Service: all occurrences are appended.
pub fn parse_agents_txt(content: &str) -> Result<AgentsTxt, DiscoveryError> {
    let mut identity: Option<String> = None;
    let mut profile_url: Option<String> = None;
    let mut said_json: Option<String> = None;
    let mut allow_agents: Vec<String> = Vec::new();
    let mut services: Vec<AgentsTxtService> = Vec::new();
    let mut auth: Option<AgentsTxtAuth> = None;

    for line in content.lines() {
        let trimmed = line.trim();

        // Skip comments and empty lines.
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        // Parse "Key: value" directives.
        let Some((key, value)) = trimmed.split_once(':') else {
            // Malformed line (no colon) — skip silently.
            continue;
        };

        let key = key.trim();
        let value = value.trim();

        if value.is_empty() {
            // Directive with no value — skip.
            continue;
        }

        match key.to_lowercase().as_str() {
            "identity" => {
                identity = Some(value.to_string());
            }
            "profile" => {
                profile_url = Some(value.to_string());
            }
            "said-json" => {
                said_json = Some(value.to_string());
            }
            "allow-agent" => {
                allow_agents.push(value.to_string());
            }
            "service" => {
                // Format: "name url"
                if let Some((name, url)) = value.split_once(char::is_whitespace) {
                    let name = name.trim();
                    let url = url.trim();
                    if !name.is_empty() && !url.is_empty() {
                        services.push(AgentsTxtService {
                            name: name.to_string(),
                            url: url.to_string(),
                        });
                    }
                }
                // If the format doesn't match, skip silently.
            }
            "auth" => {
                // Format: "method url"
                if let Some((method, url)) = value.split_once(char::is_whitespace) {
                    let method = method.trim();
                    let url = url.trim();
                    if !method.is_empty() && !url.is_empty() {
                        auth = Some(AgentsTxtAuth {
                            method: method.to_string(),
                            url: url.to_string(),
                        });
                    }
                }
            }
            _ => {
                // Unknown directive — skip silently.
            }
        }
    }

    Ok(AgentsTxt {
        identity,
        profile_url,
        said_json,
        allow_agents,
        services,
        auth,
    })
}

/// Parse the contents of a .well-known/said.json file into a `WellKnownSaid` struct.
pub fn parse_well_known_said(json: &str) -> Result<WellKnownSaid, DiscoveryError> {
    serde_json::from_str(json).map_err(DiscoveryError::from)
}

// ── Fetch Functions ──

/// Fetch and parse agents.txt from a domain (tries HTTPS first, then HTTP).
pub async fn fetch_agents_txt(
    client: &reqwest::Client,
    domain: &str,
) -> Result<AgentsTxt, DiscoveryError> {
    let url = format!("https://{}/agents.txt", domain);
    let response = client.get(&url).send().await?;

    if !response.status().is_success() {
        return Err(DiscoveryError::Http(
            response.error_for_status().unwrap_err(),
        ));
    }

    let body = response.text().await?;
    parse_agents_txt(&body)
}

/// Fetch and parse .well-known/said.json from a domain.
pub async fn fetch_well_known_said(
    client: &reqwest::Client,
    domain: &str,
) -> Result<WellKnownSaid, DiscoveryError> {
    let url = format!("https://{}/.well-known/said.json", domain);
    let response = client.get(&url).send().await?;

    if !response.status().is_success() {
        return Err(DiscoveryError::Http(
            response.error_for_status().unwrap_err(),
        ));
    }

    let body = response.text().await?;
    parse_well_known_said(&body)
}

/// Discover both agents.txt and .well-known/said.json for a domain.
/// Neither failure is fatal — the result contains `Option` for each.
pub async fn discover_domain(
    client: &reqwest::Client,
    domain: &str,
) -> Result<DomainDiscovery, DiscoveryError> {
    let agents_txt = fetch_agents_txt(client, domain).await.ok();
    let well_known = fetch_well_known_said(client, domain).await.ok();

    Ok(DomainDiscovery {
        domain: domain.to_string(),
        agents_txt,
        well_known,
    })
}

// ── Domain Verification ──

/// DNS TXT record response from Google DNS-over-HTTPS.
#[derive(serde::Deserialize)]
struct DnsResponse {
    #[serde(rename = "Answer")]
    answer: Option<Vec<DnsAnswer>>,
}

#[derive(serde::Deserialize)]
struct DnsAnswer {
    data: String,
}

/// Verify that a domain has a DNS TXT record containing the expected DID.
///
/// Uses Google's DNS-over-HTTPS API to avoid pulling in a full DNS resolver library.
/// Looks for a TXT record of the form `said-did=did:key:...` on `_said.<domain>`.
pub async fn verify_domain_dns(
    domain: &str,
    expected_did: &str,
) -> Result<bool, DiscoveryError> {
    let client = reqwest::Client::new();
    let lookup_name = format!("_said.{}", domain);
    let url = format!(
        "https://dns.google/resolve?name={}&type=TXT",
        lookup_name
    );

    let response = client
        .get(&url)
        .header("Accept", "application/dns-json")
        .send()
        .await?;

    if !response.status().is_success() {
        return Err(DiscoveryError::VerificationFailed(format!(
            "DNS query failed with status {}",
            response.status()
        )));
    }

    let dns: DnsResponse = response.json().await?;

    let expected_record = format!("said-did={}", expected_did);

    if let Some(answers) = dns.answer {
        for answer in &answers {
            // DNS TXT records may be quoted — strip surrounding quotes.
            let data = answer.data.trim_matches('"');
            if data == expected_record {
                return Ok(true);
            }
        }
    }

    Ok(false)
}

/// Verify that a domain's .well-known/said.json contains the expected DID.
pub async fn verify_domain_well_known(
    client: &reqwest::Client,
    domain: &str,
    expected_did: &str,
) -> Result<bool, DiscoveryError> {
    let well_known = fetch_well_known_said(client, domain).await?;
    Ok(well_known.did == expected_did)
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_complete_agents_txt() {
        let content = r#"
# This is an agents.txt file for Example Corp
Identity: did:key:z6Mktest1234567890
Profile: https://example.com/said/profile
Said-Json: /.well-known/said.json

# Access control
Allow-Agent: *
Allow-Agent: did:key:z6MkagentABC

# Services
Service: reservations https://api.example.com/reserve
Service: menu https://api.example.com/menu

# Authentication
Auth: ucan https://api.example.com/auth/ucan
"#;

        let result = parse_agents_txt(content).unwrap();

        assert_eq!(
            result.identity.as_deref(),
            Some("did:key:z6Mktest1234567890")
        );
        assert_eq!(
            result.profile_url.as_deref(),
            Some("https://example.com/said/profile")
        );
        assert_eq!(
            result.said_json.as_deref(),
            Some("/.well-known/said.json")
        );

        assert_eq!(result.allow_agents.len(), 2);
        assert_eq!(result.allow_agents[0], "*");
        assert_eq!(result.allow_agents[1], "did:key:z6MkagentABC");

        assert_eq!(result.services.len(), 2);
        assert_eq!(result.services[0].name, "reservations");
        assert_eq!(result.services[0].url, "https://api.example.com/reserve");
        assert_eq!(result.services[1].name, "menu");
        assert_eq!(result.services[1].url, "https://api.example.com/menu");

        let auth = result.auth.unwrap();
        assert_eq!(auth.method, "ucan");
        assert_eq!(auth.url, "https://api.example.com/auth/ucan");
    }

    #[test]
    fn test_parse_minimal_agents_txt() {
        let content = "Identity: did:key:z6MkMinimal\n";

        let result = parse_agents_txt(content).unwrap();

        assert_eq!(
            result.identity.as_deref(),
            Some("did:key:z6MkMinimal")
        );
        assert!(result.profile_url.is_none());
        assert!(result.said_json.is_none());
        assert!(result.allow_agents.is_empty());
        assert!(result.services.is_empty());
        assert!(result.auth.is_none());
    }

    #[test]
    fn test_parse_comments_and_blank_lines() {
        let content = r#"
# Comment at the top

# Another comment
Identity: did:key:z6MkCommentTest

   # Indented comment

"#;

        let result = parse_agents_txt(content).unwrap();
        assert_eq!(
            result.identity.as_deref(),
            Some("did:key:z6MkCommentTest")
        );
    }

    #[test]
    fn test_parse_empty_content() {
        let content = "";
        let result = parse_agents_txt(content).unwrap();
        assert!(result.identity.is_none());
        assert!(result.allow_agents.is_empty());
        assert!(result.services.is_empty());
    }

    #[test]
    fn test_parse_only_comments() {
        let content = "# Just a comment\n# Another comment\n";
        let result = parse_agents_txt(content).unwrap();
        assert!(result.identity.is_none());
    }

    #[test]
    fn test_duplicate_directives_last_wins() {
        let content = r#"
Identity: did:key:z6MkFirst
Identity: did:key:z6MkSecond
Profile: https://first.example.com
Profile: https://second.example.com
Said-Json: /first.json
Said-Json: /second.json
"#;

        let result = parse_agents_txt(content).unwrap();
        assert_eq!(
            result.identity.as_deref(),
            Some("did:key:z6MkSecond")
        );
        assert_eq!(
            result.profile_url.as_deref(),
            Some("https://second.example.com")
        );
        assert_eq!(
            result.said_json.as_deref(),
            Some("/second.json")
        );
    }

    #[test]
    fn test_multiple_allow_agents_accumulated() {
        let content = r#"
Allow-Agent: did:key:z6MkAgent1
Allow-Agent: did:key:z6MkAgent2
Allow-Agent: *
"#;

        let result = parse_agents_txt(content).unwrap();
        assert_eq!(result.allow_agents.len(), 3);
        assert_eq!(result.allow_agents[0], "did:key:z6MkAgent1");
        assert_eq!(result.allow_agents[1], "did:key:z6MkAgent2");
        assert_eq!(result.allow_agents[2], "*");
    }

    #[test]
    fn test_multiple_services_accumulated() {
        let content = r#"
Service: api https://api.example.com
Service: docs https://docs.example.com
Service: status https://status.example.com
"#;

        let result = parse_agents_txt(content).unwrap();
        assert_eq!(result.services.len(), 3);
        assert_eq!(result.services[2].name, "status");
        assert_eq!(result.services[2].url, "https://status.example.com");
    }

    #[test]
    fn test_malformed_lines_skipped() {
        let content = r#"
Identity: did:key:z6MkValid
This line has no colon
Also malformed
Service: reservations https://api.example.com/reserve
"#;

        let result = parse_agents_txt(content).unwrap();
        assert_eq!(
            result.identity.as_deref(),
            Some("did:key:z6MkValid")
        );
        assert_eq!(result.services.len(), 1);
    }

    #[test]
    fn test_unknown_directives_skipped() {
        let content = r#"
Identity: did:key:z6MkKnown
X-Custom: some-value
Foobar: baz
"#;

        let result = parse_agents_txt(content).unwrap();
        assert_eq!(
            result.identity.as_deref(),
            Some("did:key:z6MkKnown")
        );
    }

    #[test]
    fn test_case_insensitive_keys() {
        let content = r#"
identity: did:key:z6MkLowerCase
PROFILE: https://example.com/profile
said-json: /said.json
allow-agent: *
service: api https://api.example.com
auth: ucan https://auth.example.com
"#;

        let result = parse_agents_txt(content).unwrap();
        assert_eq!(
            result.identity.as_deref(),
            Some("did:key:z6MkLowerCase")
        );
        assert_eq!(
            result.profile_url.as_deref(),
            Some("https://example.com/profile")
        );
        assert_eq!(result.said_json.as_deref(), Some("/said.json"));
        assert_eq!(result.allow_agents.len(), 1);
        assert_eq!(result.services.len(), 1);
        assert!(result.auth.is_some());
    }

    #[test]
    fn test_service_with_missing_url_skipped() {
        let content = r#"
Service: onlyname
Service: valid https://api.example.com
"#;

        let result = parse_agents_txt(content).unwrap();
        // "onlyname" has no space-separated URL, so it's skipped.
        assert_eq!(result.services.len(), 1);
        assert_eq!(result.services[0].name, "valid");
    }

    #[test]
    fn test_auth_with_missing_url_skipped() {
        let content = r#"
Auth: onlymethod
Identity: did:key:z6MkTest
"#;

        let result = parse_agents_txt(content).unwrap();
        assert!(result.auth.is_none());
    }

    #[test]
    fn test_directive_with_empty_value_skipped() {
        let content = r#"
Identity:
Profile: https://example.com
"#;

        let result = parse_agents_txt(content).unwrap();
        // "Identity:" with no value after trimming -> skipped.
        assert!(result.identity.is_none());
        assert_eq!(
            result.profile_url.as_deref(),
            Some("https://example.com")
        );
    }

    #[test]
    fn test_value_with_colons_preserved() {
        // URL values contain colons — the split should be on the first colon only.
        let content = "Profile: https://example.com:8080/path\n";

        let result = parse_agents_txt(content).unwrap();
        assert_eq!(
            result.profile_url.as_deref(),
            Some("https://example.com:8080/path")
        );
    }

    #[test]
    fn test_parse_well_known_said() {
        let json = r#"{
            "said_version": "0.1",
            "did": "did:key:z6MkTest",
            "profile_url": "https://example.com/profile",
            "business": {
                "name": "Test Corp",
                "category": "saas",
                "description": "A test business"
            },
            "services": [],
            "operating_hours": null,
            "verification": {
                "method": "dns-txt",
                "record": "_said.example.com"
            }
        }"#;

        let result = parse_well_known_said(json).unwrap();
        assert_eq!(result.said_version, "0.1");
        assert_eq!(result.did, "did:key:z6MkTest");
        assert_eq!(
            result.profile_url.as_deref(),
            Some("https://example.com/profile")
        );

        let business = result.business.unwrap();
        assert_eq!(business.name, "Test Corp");
        assert_eq!(business.category.as_deref(), Some("saas"));

        let verification = result.verification.unwrap();
        assert_eq!(verification.method, "dns-txt");
        assert_eq!(
            verification.record.as_deref(),
            Some("_said.example.com")
        );
    }

    #[test]
    fn test_parse_well_known_said_minimal() {
        let json = r#"{
            "said_version": "0.1",
            "did": "did:key:z6MkMinimal",
            "services": []
        }"#;

        let result = parse_well_known_said(json).unwrap();
        assert_eq!(result.did, "did:key:z6MkMinimal");
        assert!(result.business.is_none());
        assert!(result.verification.is_none());
        assert!(result.profile_url.is_none());
    }

    #[test]
    fn test_parse_well_known_said_invalid_json() {
        let json = "not json at all";
        let result = parse_well_known_said(json);
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), DiscoveryError::Json(_)));
    }

    #[test]
    fn test_domain_discovery_struct() {
        let discovery = DomainDiscovery {
            domain: "example.com".to_string(),
            agents_txt: Some(AgentsTxt {
                identity: Some("did:key:z6MkTest".to_string()),
                profile_url: None,
                said_json: None,
                allow_agents: vec!["*".to_string()],
                services: vec![],
                auth: None,
            }),
            well_known: None,
        };

        assert_eq!(discovery.domain, "example.com");
        assert!(discovery.agents_txt.is_some());
        assert!(discovery.well_known.is_none());

        let agents = discovery.agents_txt.unwrap();
        assert_eq!(
            agents.identity.as_deref(),
            Some("did:key:z6MkTest")
        );
        assert_eq!(agents.allow_agents, vec!["*"]);
    }

    #[test]
    fn test_auth_last_occurrence_wins() {
        let content = r#"
Auth: bearer https://first.example.com/auth
Auth: ucan https://second.example.com/auth
"#;

        let result = parse_agents_txt(content).unwrap();
        let auth = result.auth.unwrap();
        assert_eq!(auth.method, "ucan");
        assert_eq!(auth.url, "https://second.example.com/auth");
    }

    #[test]
    fn test_whitespace_handling() {
        let content = "  Identity:   did:key:z6MkSpaces   \n  Profile:  https://example.com  \n";

        let result = parse_agents_txt(content).unwrap();
        assert_eq!(
            result.identity.as_deref(),
            Some("did:key:z6MkSpaces")
        );
        assert_eq!(
            result.profile_url.as_deref(),
            Some("https://example.com")
        );
    }
}

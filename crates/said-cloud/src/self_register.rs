//! Self-registration — SAID registers its own APIs as services in its own registry.
//! This is Ghola eating its own dog food as a headless merchant.

use sqlx::PgPool;

use crate::routes::pricing::pricing_catalog;

/// Register SAID's own API services in the service registry.
/// Called once at startup. Upserts by slug to avoid duplicates.
pub async fn register_self(db: &PgPool, base_url: &str) {
    let services = vec![
        SelfService {
            name: "SAID Agent Verification",
            slug: "said-verify-agent",
            description: "Verify an AI agent's identity, UCAN capabilities, and trust score in a single API call. Returns profile info, on-chain status, verified badge, capability list, and composite trust score.",
            category: "developer-tools",
            tags: vec!["identity", "verification", "ucan", "trust", "agent"],
        },
        SelfService {
            name: "SAID Reputation Lookup",
            slug: "said-reputation",
            description: "Get composite reputation scores for any DID — identity, transaction, quality, reliability, and history components with confidence level.",
            category: "data",
            tags: vec!["reputation", "trust", "scoring", "identity"],
        },
        SelfService {
            name: "SAID Service Resolution",
            slug: "said-resolve-services",
            description: "Search and rank headless merchant services by task description, category, price, quality, uptime, and trust score. DNS for the agent economy.",
            category: "search",
            tags: vec!["discovery", "search", "marketplace", "services", "resolution"],
        },
        SelfService {
            name: "SAID Identity Resolution",
            slug: "said-resolve-identity",
            description: "Resolve any DID or @handle to a full identity profile including business info, consumer preferences, and registered services.",
            category: "data",
            tags: vec!["identity", "resolution", "did", "profile"],
        },
        SelfService {
            name: "SAID Delegation Verification",
            slug: "said-verify-delegation",
            description: "Verify a UCAN delegation chain with full revocation checking. Confirms every link in the chain is valid, unexpired, and unrevoked.",
            category: "developer-tools",
            tags: vec!["delegation", "ucan", "verification", "revocation", "chain"],
        },
        SelfService {
            name: "SAID Domain Discovery",
            slug: "said-discover-domain",
            description: "Discover a business by domain — fetches and parses agents.txt and .well-known/said.json, returning structured identity and service data.",
            category: "search",
            tags: vec!["discovery", "domain", "agents-txt", "well-known"],
        },
    ];

    let catalog = pricing_catalog();

    for svc in &services {
        // Find matching price from catalog
        let price = catalog
            .iter()
            .find(|e| {
                svc.slug.contains(&e.path.split('/').last().unwrap_or("").replace('{', "").replace('}', ""))
                    || svc.slug.contains("verify-agent") && e.path.contains("verify/agent")
                    || svc.slug.contains("reputation") && e.path.contains("reputation")
                    || svc.slug.contains("resolve-services") && e.path.contains("services/resolve")
                    || svc.slug.contains("resolve-identity") && e.path.contains("resolve/")
                    || svc.slug.contains("verify-delegation") && e.path.contains("delegation/verify")
                    || svc.slug.contains("discover-domain") && e.path.contains("discover")
            })
            .map(|e| e.price_micro_usdc)
            .unwrap_or(1000);

        let free_tier = catalog
            .iter()
            .find(|e| {
                svc.slug.contains("verify-agent") && e.path.contains("verify/agent")
                    || svc.slug.contains("reputation") && e.path.contains("reputation")
                    || svc.slug.contains("resolve-services") && e.path.contains("services/resolve")
                    || svc.slug.contains("resolve-identity") && e.path.contains("resolve/")
                    || svc.slug.contains("verify-delegation") && e.path.contains("delegation/verify")
                    || svc.slug.contains("discover-domain") && e.path.contains("discover")
            })
            .map(|e| e.free_tier_per_day)
            .unwrap_or(100);

        let endpoints_json = serde_json::json!([{
            "name": svc.name,
            "path": format!("/v1/{}", svc.slug.strip_prefix("said-").unwrap_or(&svc.slug)),
            "method": "GET",
            "description": svc.description,
            "price_micro_usdc": price,
        }]);

        // Upsert by slug
        let result = sqlx::query(
            r#"INSERT INTO service_listings (
                owner_id, owner_did, name, slug, description, category, tags,
                base_url, auth_type, auth_details, pricing_model, price_micro_usdc,
                free_tier_requests, endpoints, status, receive_address
            )
            SELECT
                u.id, COALESCE(bp.did, pp.did, 'did:key:ghola-platform'), $3, $4, $5, $6, $7,
                $8, 'none', '{}', 'per_request', $9,
                $10, $11, 'active', $12
            FROM users u
            LEFT JOIN business_profiles bp ON bp.user_id = u.id
            LEFT JOIN public_profiles pp ON pp.user_id = u.id
            WHERE u.email = 'platform@ghola.xyz'
            LIMIT 1
            ON CONFLICT (slug) DO UPDATE SET
                description = EXCLUDED.description,
                price_micro_usdc = EXCLUDED.price_micro_usdc,
                free_tier_requests = EXCLUDED.free_tier_requests,
                endpoints = EXCLUDED.endpoints,
                status = 'active'::service_status"#,
        )
        .bind(svc.name) // $3
        .bind(svc.slug) // $4
        .bind(svc.description) // $5
        .bind(svc.category) // $6
        .bind(&svc.tags) // $7
        .bind(base_url) // $8
        .bind(price) // $9
        .bind(free_tier) // $10
        .bind(&endpoints_json) // $11
        .bind(std::env::var("ESCROW_WALLET_ADDRESS").unwrap_or_default()) // $12
        .execute(db)
        .await;

        match result {
            Ok(r) if r.rows_affected() > 0 => {
                tracing::info!("Self-registered service: {} ({})", svc.name, svc.slug);
            }
            Ok(_) => {
                tracing::debug!("Self-registration skipped (no platform user): {}", svc.slug);
            }
            Err(e) => {
                tracing::warn!("Self-registration failed for {}: {}", svc.slug, e);
            }
        }
    }
}

struct SelfService {
    name: &'static str,
    slug: &'static str,
    description: &'static str,
    category: &'static str,
    tags: Vec<&'static str>,
}

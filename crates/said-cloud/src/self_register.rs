//! Self-registration — SAID registers its own APIs as services in its own registry.
//! This is Ghola eating its own dog food as a headless merchant.

use sqlx::PgPool;

use crate::routes::pricing::pricing_catalog;

/// Ensure the platform user exists, then register SAID's own API services.
pub async fn register_self(db: &PgPool, base_url: &str) {
    // Auto-create platform user if it doesn't exist
    let platform_user_id = ensure_platform_user(db).await;
    let Some(user_id) = platform_user_id else {
        tracing::warn!("Could not create/find platform user — skipping self-registration");
        return;
    };

    // Get or create a DID for the platform
    let platform_did = get_or_create_platform_did(db, user_id).await;

    let services = vec![
        SelfService {
            name: "SAID Agent Verification",
            slug: "said-verify-agent",
            description: "Verify an AI agent's identity, UCAN capabilities, and trust score in a single API call.",
            category: "developer-tools",
            tags: vec!["identity", "verification", "ucan", "trust", "agent"],
        },
        SelfService {
            name: "SAID Reputation Lookup",
            slug: "said-reputation",
            description: "Get composite reputation scores for any DID — identity, transaction, quality, reliability, and history components.",
            category: "data",
            tags: vec!["reputation", "trust", "scoring", "identity"],
        },
        SelfService {
            name: "SAID Service Resolution",
            slug: "said-resolve-services",
            description: "Search and rank headless merchant services by task description, category, price, quality, and trust score.",
            category: "search",
            tags: vec!["discovery", "search", "marketplace", "services"],
        },
        SelfService {
            name: "SAID Identity Resolution",
            slug: "said-resolve-identity",
            description: "Resolve any DID or @handle to a full identity profile including business info and registered services.",
            category: "data",
            tags: vec!["identity", "resolution", "did", "profile"],
        },
        SelfService {
            name: "SAID Delegation Verification",
            slug: "said-verify-delegation",
            description: "Verify a full UCAN delegation chain with revocation checking across all levels.",
            category: "developer-tools",
            tags: vec!["delegation", "ucan", "verification", "revocation"],
        },
        SelfService {
            name: "SAID Domain Discovery",
            slug: "said-discover-domain",
            description: "Discover a business by domain — fetches agents.txt and .well-known/said.json.",
            category: "search",
            tags: vec!["discovery", "domain", "agents-txt"],
        },
    ];

    let catalog = pricing_catalog();
    let receive_addr = std::env::var("ESCROW_WALLET_ADDRESS").unwrap_or_default();

    for svc in &services {
        let price = find_price(&catalog, svc.slug);
        let free_tier = find_free_tier(&catalog, svc.slug);

        let endpoints_json = serde_json::json!([{
            "name": svc.name,
            "path": format!("/v1/{}", svc.slug.strip_prefix("said-").unwrap_or(svc.slug)),
            "method": "GET",
            "description": svc.description,
            "price_micro_usdc": price,
        }]);

        let result = sqlx::query(
            r#"INSERT INTO service_listings (
                owner_id, owner_did, name, slug, description, category, tags,
                base_url, auth_type, auth_details, pricing_model, price_micro_usdc,
                free_tier_requests, endpoints, status, receive_address
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7,
                $8, 'none'::service_auth_type, '{}'::jsonb, 'per_request'::pricing_model, $9,
                $10, $11, 'active'::service_status, $12
            )
            ON CONFLICT (slug) DO UPDATE SET
                description = EXCLUDED.description,
                price_micro_usdc = EXCLUDED.price_micro_usdc,
                free_tier_requests = EXCLUDED.free_tier_requests,
                endpoints = EXCLUDED.endpoints,
                status = 'active'::service_status"#,
        )
        .bind(user_id)
        .bind(&platform_did)
        .bind(svc.name)
        .bind(svc.slug)
        .bind(svc.description)
        .bind(svc.category)
        .bind(&svc.tags)
        .bind(base_url)
        .bind(price)
        .bind(free_tier)
        .bind(&endpoints_json)
        .bind(&receive_addr)
        .execute(db)
        .await;

        match result {
            Ok(_) => {
                tracing::info!("Self-registered: {} ({})", svc.name, svc.slug);
            }
            Err(e) => {
                tracing::warn!("Self-registration failed for {}: {}", svc.slug, e);
            }
        }
    }
}

async fn ensure_platform_user(db: &PgPool) -> Option<uuid::Uuid> {
    // Check if platform user exists
    let existing: Option<uuid::Uuid> = sqlx::query_scalar(
        "SELECT id FROM users WHERE email = 'platform@ghola.xyz'",
    )
    .fetch_optional(db)
    .await
    .ok()
    .flatten();

    if let Some(id) = existing {
        return Some(id);
    }

    // Create platform user with a random password hash
    let password_hash = "$argon2id$v=19$m=19456,t=2,p=1$platform$placeholder";
    let result: Option<uuid::Uuid> = sqlx::query_scalar(
        "INSERT INTO users (email, password_hash, account_type) VALUES ('platform@ghola.xyz', $1, 'business') RETURNING id",
    )
    .bind(password_hash)
    .fetch_optional(db)
    .await
    .ok()
    .flatten();

    if let Some(id) = result {
        tracing::info!("Created platform user: platform@ghola.xyz ({})", id);
        Some(id)
    } else {
        None
    }
}

async fn get_or_create_platform_did(db: &PgPool, user_id: uuid::Uuid) -> String {
    // Check for existing profile
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT did FROM business_profiles WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten();

    if let Some(did) = existing {
        return did;
    }

    // Create a platform DID
    let did = format!("did:key:ghola-platform-{}", uuid::Uuid::new_v4());

    sqlx::query(
        r#"INSERT INTO business_profiles (user_id, did, business_name, handle, category, description, website, services, policies, api_endpoints, payment_methods)
        VALUES ($1, $2, 'Ghola Platform', 'ghola', 'developer-tools', 'Agent Identity Protocol — identity, discovery, trust, and commerce for AI agents.', 'https://ghola.xyz', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)
        ON CONFLICT DO NOTHING"#,
    )
    .bind(user_id)
    .bind(&did)
    .execute(db)
    .await
    .ok();

    tracing::info!("Created platform profile: {}", did);
    did
}

fn find_price(catalog: &[crate::routes::pricing::PricedEndpoint], slug: &str) -> i64 {
    let mappings = [
        ("said-verify-agent", "verify/agent"),
        ("said-reputation", "reputation"),
        ("said-resolve-services", "services/resolve"),
        ("said-resolve-identity", "resolve/"),
        ("said-verify-delegation", "delegation/verify"),
        ("said-discover-domain", "discover"),
    ];

    for (s, path_fragment) in &mappings {
        if slug == *s {
            return catalog
                .iter()
                .find(|e| e.path.contains(path_fragment))
                .map(|e| e.price_micro_usdc)
                .unwrap_or(1000);
        }
    }
    1000
}

fn find_free_tier(catalog: &[crate::routes::pricing::PricedEndpoint], slug: &str) -> i32 {
    let mappings = [
        ("said-verify-agent", "verify/agent"),
        ("said-reputation", "reputation"),
        ("said-resolve-services", "services/resolve"),
        ("said-resolve-identity", "resolve/"),
        ("said-verify-delegation", "delegation/verify"),
        ("said-discover-domain", "discover"),
    ];

    for (s, path_fragment) in &mappings {
        if slug == *s {
            return catalog
                .iter()
                .find(|e| e.path.contains(path_fragment))
                .map(|e| e.free_tier_per_day)
                .unwrap_or(100);
        }
    }
    100
}

struct SelfService {
    name: &'static str,
    slug: &'static str,
    description: &'static str,
    category: &'static str,
    tags: Vec<&'static str>,
}

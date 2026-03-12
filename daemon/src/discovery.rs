use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

/// Auto-discover and configure known AI tool configs.
pub fn auto_discover(port: u16) -> Vec<String> {
    let mut configured = Vec::new();

    if configure_claude_code(port) {
        configured.push("Claude Code (~/.claude.json)".to_string());
    }
    if configure_cursor(port) {
        configured.push("Cursor (~/.cursor/mcp.json)".to_string());
    }

    configured
}

/// Remove SAID from all known AI tool configs.
pub fn unregister_all() -> Vec<String> {
    let mut removed = Vec::new();

    if unconfigure_claude_code() {
        removed.push("Claude Code (~/.claude.json)".to_string());
    }
    if unconfigure_cursor() {
        removed.push("Cursor (~/.cursor/mcp.json)".to_string());
    }

    removed
}

fn claude_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude.json"))
}

fn cursor_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".cursor").join("mcp.json"))
}

fn configure_claude_code(port: u16) -> bool {
    let Some(config_path) = claude_config_path() else {
        return false;
    };

    let mut config: Value = if config_path.exists() {
        match fs::read_to_string(&config_path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or(json!({})),
            Err(_) => return false,
        }
    } else {
        json!({})
    };

    let servers = config
        .as_object_mut()
        .unwrap()
        .entry("mcpServers")
        .or_insert(json!({}));

    servers.as_object_mut().unwrap().insert(
        "said".to_string(),
        json!({ "url": format!("http://127.0.0.1:{}/mcp", port) }),
    );

    fs::write(
        &config_path,
        serde_json::to_string_pretty(&config).unwrap(),
    )
    .is_ok()
}

fn configure_cursor(port: u16) -> bool {
    let Some(config_path) = cursor_config_path() else {
        return false;
    };

    // Ensure .cursor directory exists
    if let Some(parent) = config_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let mut config: Value = if config_path.exists() {
        match fs::read_to_string(&config_path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or(json!({})),
            Err(_) => return false,
        }
    } else {
        json!({})
    };

    let servers = config
        .as_object_mut()
        .unwrap()
        .entry("mcpServers")
        .or_insert(json!({}));

    servers.as_object_mut().unwrap().insert(
        "said".to_string(),
        json!({ "url": format!("http://127.0.0.1:{}/mcp", port) }),
    );

    fs::write(
        &config_path,
        serde_json::to_string_pretty(&config).unwrap(),
    )
    .is_ok()
}

fn unconfigure_claude_code() -> bool {
    let Some(config_path) = claude_config_path() else {
        return false;
    };
    if !config_path.exists() {
        return false;
    }

    let Ok(s) = fs::read_to_string(&config_path) else {
        return false;
    };
    let Ok(mut config) = serde_json::from_str::<Value>(&s) else {
        return false;
    };

    if let Some(servers) = config
        .get_mut("mcpServers")
        .and_then(|s| s.as_object_mut())
    {
        if servers.remove("said").is_some() {
            return fs::write(
                &config_path,
                serde_json::to_string_pretty(&config).unwrap(),
            )
            .is_ok();
        }
    }
    false
}

fn unconfigure_cursor() -> bool {
    let Some(config_path) = cursor_config_path() else {
        return false;
    };
    if !config_path.exists() {
        return false;
    }

    let Ok(s) = fs::read_to_string(&config_path) else {
        return false;
    };
    let Ok(mut config) = serde_json::from_str::<Value>(&s) else {
        return false;
    };

    if let Some(servers) = config
        .get_mut("mcpServers")
        .and_then(|s| s.as_object_mut())
    {
        if servers.remove("said").is_some() {
            return fs::write(
                &config_path,
                serde_json::to_string_pretty(&config).unwrap(),
            )
            .is_ok();
        }
    }
    false
}

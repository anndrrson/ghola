use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

/// Result of attempting to configure a single AI tool.
pub struct DiscoveryResult {
    pub name: &'static str,
    pub configured: bool,
    /// If not configured, why (e.g. "not found")
    pub reason: Option<&'static str>,
}

/// Auto-discover and configure known AI tool configs.
/// Returns results for all known tools (both successes and failures).
pub fn auto_discover(port: u16) -> Vec<DiscoveryResult> {
    vec![
        DiscoveryResult {
            name: "Claude Code",
            configured: configure_claude_code(port),
            reason: if claude_config_path().is_some() {
                None
            } else {
                Some("not installed")
            },
        },
        DiscoveryResult {
            name: "Cursor",
            configured: configure_cursor(port),
            reason: if cursor_config_path().is_some() {
                None
            } else {
                Some("not installed")
            },
        },
        DiscoveryResult {
            name: "Claude Desktop",
            configured: configure_claude_desktop(port),
            reason: if claude_desktop_config_path().is_some() {
                None
            } else {
                Some("not found (install from claude.ai/download)")
            },
        },
        DiscoveryResult {
            name: "Windsurf",
            configured: configure_windsurf(port),
            reason: if windsurf_config_path().is_some() {
                None
            } else {
                Some("not installed")
            },
        },
    ]
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
    if unconfigure_claude_desktop() {
        removed.push("Claude Desktop".to_string());
    }
    if unconfigure_windsurf() {
        removed.push("Windsurf".to_string());
    }

    removed
}

fn claude_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude.json"))
}

fn cursor_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".cursor").join("mcp.json"))
}

fn claude_desktop_config_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir()
            .map(|h| h.join("Library/Application Support/Claude/claude_desktop_config.json"))
            .filter(|p| p.parent().map(|d| d.exists()).unwrap_or(false))
    }
    #[cfg(target_os = "linux")]
    {
        dirs::home_dir()
            .map(|h| h.join(".config/Claude/claude_desktop_config.json"))
            .filter(|p| p.parent().map(|d| d.exists()).unwrap_or(false))
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA")
            .ok()
            .map(|d| PathBuf::from(d).join("Claude/claude_desktop_config.json"))
            .filter(|p| p.parent().map(|d| d.exists()).unwrap_or(false))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        None
    }
}

fn windsurf_config_path() -> Option<PathBuf> {
    dirs::home_dir()
        .map(|h| h.join(".codeium").join("windsurf").join("mcp_config.json"))
        .filter(|p| p.parent().map(|d| d.exists()).unwrap_or(false))
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

    fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap()).is_ok()
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

    fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap()).is_ok()
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

    if let Some(servers) = config.get_mut("mcpServers").and_then(|s| s.as_object_mut()) {
        if servers.remove("said").is_some() {
            return fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap()).is_ok();
        }
    }
    false
}

fn configure_claude_desktop(port: u16) -> bool {
    let Some(config_path) = claude_desktop_config_path() else {
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

    fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap()).is_ok()
}

fn configure_windsurf(port: u16) -> bool {
    let Some(config_path) = windsurf_config_path() else {
        return false;
    };

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

    fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap()).is_ok()
}

fn unconfigure_claude_desktop() -> bool {
    let Some(config_path) = claude_desktop_config_path() else {
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

    if let Some(servers) = config.get_mut("mcpServers").and_then(|s| s.as_object_mut()) {
        if servers.remove("said").is_some() {
            return fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap()).is_ok();
        }
    }
    false
}

fn unconfigure_windsurf() -> bool {
    let Some(config_path) = windsurf_config_path() else {
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

    if let Some(servers) = config.get_mut("mcpServers").and_then(|s| s.as_object_mut()) {
        if servers.remove("said").is_some() {
            return fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap()).is_ok();
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

    if let Some(servers) = config.get_mut("mcpServers").and_then(|s| s.as_object_mut()) {
        if servers.remove("said").is_some() {
            return fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap()).is_ok();
        }
    }
    false
}

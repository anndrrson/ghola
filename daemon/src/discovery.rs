use serde_json::{json, Value};
use serde_yaml::{Mapping, Value as YamlValue};
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
            reason: if claude_config_path().is_some() { None } else { Some("not installed") },
        },
        DiscoveryResult {
            name: "Cursor",
            configured: configure_cursor(port),
            reason: if cursor_config_path().is_some() { None } else { Some("not installed") },
        },
        DiscoveryResult {
            name: "Claude Desktop",
            configured: configure_claude_desktop(port),
            reason: if claude_desktop_config_path().is_some() { None } else { Some("not found (install from claude.ai/download)") },
        },
        DiscoveryResult {
            name: "Windsurf",
            configured: configure_windsurf(port),
            reason: if windsurf_config_path().is_some() { None } else { Some("not installed") },
        },
        DiscoveryResult {
            name: "Hermes Agent",
            configured: configure_hermes(),
            reason: if hermes_config_path().is_some() { None } else { Some("not installed") },
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
    if unconfigure_hermes() {
        removed.push("Hermes Agent (~/.hermes/config.yaml)".to_string());
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

fn hermes_config_path() -> Option<PathBuf> {
    dirs::home_dir()
        .map(|h| h.join(".hermes").join("config.yaml"))
        .filter(|p| p.parent().map(|d| d.exists()).unwrap_or(false))
}

fn said_command() -> String {
    std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "said".to_string())
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

    fs::write(
        &config_path,
        serde_json::to_string_pretty(&config).unwrap(),
    )
    .is_ok()
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

    fs::write(
        &config_path,
        serde_json::to_string_pretty(&config).unwrap(),
    )
    .is_ok()
}

fn configure_hermes() -> bool {
    let Some(config_path) = hermes_config_path() else {
        return false;
    };

    let mut config: YamlValue = if config_path.exists() {
        match fs::read_to_string(&config_path) {
            Ok(s) => serde_yaml::from_str(&s).unwrap_or(YamlValue::Mapping(Mapping::new())),
            Err(_) => return false,
        }
    } else {
        YamlValue::Mapping(Mapping::new())
    };

    configure_hermes_value(&mut config, &said_command());

    fs::write(
        &config_path,
        serde_yaml::to_string(&config).unwrap_or_default(),
    )
    .is_ok()
}

fn configure_hermes_value(config: &mut YamlValue, command: &str) {
    if !matches!(config, YamlValue::Mapping(_)) {
        *config = YamlValue::Mapping(Mapping::new());
    }

    let root = config.as_mapping_mut().unwrap();
    let servers_key = YamlValue::String("mcp_servers".to_string());
    let servers = root
        .entry(servers_key)
        .or_insert_with(|| YamlValue::Mapping(Mapping::new()));
    if !matches!(servers, YamlValue::Mapping(_)) {
        *servers = YamlValue::Mapping(Mapping::new());
    }

    let mut ghola = Mapping::new();
    ghola.insert(
        YamlValue::String("command".to_string()),
        YamlValue::String(command.to_string()),
    );
    ghola.insert(
        YamlValue::String("args".to_string()),
        YamlValue::Sequence(vec![YamlValue::String("serve".to_string())]),
    );
    ghola.insert(YamlValue::String("enabled".to_string()), YamlValue::Bool(true));

    servers
        .as_mapping_mut()
        .unwrap()
        .insert(YamlValue::String("ghola".to_string()), YamlValue::Mapping(ghola));
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

fn unconfigure_hermes() -> bool {
    let Some(config_path) = hermes_config_path() else {
        return false;
    };
    if !config_path.exists() {
        return false;
    }

    let Ok(s) = fs::read_to_string(&config_path) else {
        return false;
    };
    let Ok(mut config) = serde_yaml::from_str::<YamlValue>(&s) else {
        return false;
    };

    let Some(servers) = config
        .as_mapping_mut()
        .and_then(|root| root.get_mut(&YamlValue::String("mcp_servers".to_string())))
        .and_then(|servers| servers.as_mapping_mut())
    else {
        return false;
    };

    if servers
        .remove(&YamlValue::String("ghola".to_string()))
        .is_none()
    {
        return false;
    }

    fs::write(
        &config_path,
        serde_yaml::to_string(&config).unwrap_or_default(),
    )
    .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hermes_config_preserves_existing_servers_and_adds_ghola_stdio() {
        let mut config: YamlValue = serde_yaml::from_str(
            r#"
model:
  provider: openai
mcp_servers:
  filesystem:
    command: npx
    args:
      - -y
      - "@modelcontextprotocol/server-filesystem"
"#,
        )
        .unwrap();

        configure_hermes_value(&mut config, "/usr/local/bin/ghola");

        let root = config.as_mapping().unwrap();
        let servers = root
            .get(&YamlValue::String("mcp_servers".to_string()))
            .unwrap()
            .as_mapping()
            .unwrap();
        assert!(servers.contains_key(&YamlValue::String("filesystem".to_string())));

        let ghola = servers
            .get(&YamlValue::String("ghola".to_string()))
            .unwrap()
            .as_mapping()
            .unwrap();
        assert_eq!(
            ghola
                .get(&YamlValue::String("command".to_string()))
                .unwrap(),
            &YamlValue::String("/usr/local/bin/ghola".to_string())
        );
        assert_eq!(
            ghola.get(&YamlValue::String("args".to_string())).unwrap(),
            &YamlValue::Sequence(vec![YamlValue::String("serve".to_string())])
        );
        assert_eq!(
            ghola
                .get(&YamlValue::String("enabled".to_string()))
                .unwrap(),
            &YamlValue::Bool(true)
        );
    }
}

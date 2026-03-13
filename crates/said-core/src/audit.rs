use std::collections::HashMap;
use std::path::PathBuf;

use chrono::Utc;
use serde::Serialize;

use crate::wallet::Wallet;
use said_types::{Capability, KnowledgeDoc, McpConfig, Memory, Preference, ProviderSession, Secret, SystemPrompt};

// ── Severity ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Low,
    Medium,
    High,
    Critical,
}

impl std::fmt::Display for Severity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Severity::Low => write!(f, "LOW"),
            Severity::Medium => write!(f, "MEDIUM"),
            Severity::High => write!(f, "HIGH"),
            Severity::Critical => write!(f, "CRITICAL"),
        }
    }
}

// ── Finding ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct Finding {
    pub id: String,
    pub severity: Severity,
    pub title: String,
    pub description: String,
    pub fix_command: Option<String>,
    pub auto_fixable: bool,
}

// ── VaultSummary ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct VaultSummary {
    pub vault_path: PathBuf,
    pub secrets_count: usize,
    pub sessions_total: usize,
    pub sessions_expired: usize,
    pub sessions_revoked: usize,
    pub memories_count: usize,
    pub prompts_count: usize,
    pub knowledge_count: usize,
    pub preferences_count: usize,
    pub mcp_configs_count: usize,
    pub seed_encrypted: bool,
    pub daemon_running: bool,
    pub daemon_pid: Option<u32>,
    pub clients_found: Vec<String>,
}

// ── AuditReport ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct AuditReport {
    pub summary: VaultSummary,
    pub findings: Vec<Finding>,
    pub score: u32,
}

// ── Index Phase ─────────────────────────────────────────────────────────────

pub fn index_vault(wallet: &Wallet) -> VaultSummary {
    let vault_path = wallet.wallet_dir().clone();

    let secrets: Vec<Secret> = wallet.storage().load("secrets").unwrap_or_default();
    let sessions: Vec<ProviderSession> = wallet.list_sessions().unwrap_or_default();
    let memories: Vec<Memory> = wallet.storage().load("memories").unwrap_or_default();
    let prompts: Vec<SystemPrompt> = wallet.storage().load("prompts").unwrap_or_default();
    let knowledge: Vec<KnowledgeDoc> = wallet.storage().load("knowledge").unwrap_or_default();
    let preferences: Vec<Preference> = wallet.storage().load("preferences").unwrap_or_default();
    let mcp_configs: Vec<McpConfig> = wallet.storage().load("mcp_configs").unwrap_or_default();

    let now = Utc::now();
    let sessions_expired = sessions
        .iter()
        .filter(|s| !s.revoked && s.expires_at < now)
        .count();
    let sessions_revoked = sessions.iter().filter(|s| s.revoked).count();

    // Load metadata to check seed_encrypted
    let seed_encrypted = Wallet::load_metadata(&vault_path)
        .map(|m| m.seed_encrypted)
        .unwrap_or(false);

    // Check daemon
    let (daemon_running, daemon_pid) = check_daemon(&vault_path);

    // Check MCP clients
    let clients_found = discover_clients();

    VaultSummary {
        vault_path,
        secrets_count: secrets.len(),
        sessions_total: sessions.len(),
        sessions_expired,
        sessions_revoked,
        memories_count: memories.len(),
        prompts_count: prompts.len(),
        knowledge_count: knowledge.len(),
        preferences_count: preferences.len(),
        mcp_configs_count: mcp_configs.len(),
        seed_encrypted,
        daemon_running,
        daemon_pid,
        clients_found,
    }
}

fn check_daemon(wallet_dir: &PathBuf) -> (bool, Option<u32>) {
    let pid_path = wallet_dir.join("daemon.pid");
    let pid_str = match std::fs::read_to_string(&pid_path) {
        Ok(s) => s,
        Err(_) => return (false, None),
    };
    let pid: u32 = match pid_str.trim().parse() {
        Ok(p) => p,
        Err(_) => return (false, None),
    };

    // Check if process is alive
    let alive = std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    (alive, if alive { Some(pid) } else { None })
}

fn discover_clients() -> Vec<String> {
    let mut found = Vec::new();
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return found,
    };

    // Claude Code
    let claude_code = home.join(".claude.json");
    if claude_code.exists() {
        if has_said_config(&claude_code) {
            found.push("Claude Code".to_string());
        }
    }

    // Cursor
    let cursor = home.join(".cursor").join("mcp.json");
    if cursor.exists() {
        if has_said_config(&cursor) {
            found.push("Cursor".to_string());
        }
    }

    // Claude Desktop
    #[cfg(target_os = "macos")]
    let claude_desktop = Some(
        home.join("Library/Application Support/Claude/claude_desktop_config.json"),
    );
    #[cfg(target_os = "linux")]
    let claude_desktop = Some(home.join(".config/Claude/claude_desktop_config.json"));
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let claude_desktop: Option<PathBuf> = None;

    if let Some(path) = claude_desktop {
        if path.exists() && has_said_config(&path) {
            found.push("Claude Desktop".to_string());
        }
    }

    // Windsurf
    let windsurf = home
        .join(".codeium")
        .join("windsurf")
        .join("mcp_config.json");
    if windsurf.exists() && has_said_config(&windsurf) {
        found.push("Windsurf".to_string());
    }

    found
}

fn has_said_config(path: &PathBuf) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("mcpServers")?.get("said").cloned())
        .is_some()
}

// ── Analyze Phase ───────────────────────────────────────────────────────────

pub fn analyze(wallet: &Wallet, summary: &VaultSummary) -> Vec<Finding> {
    let mut findings = Vec::new();

    let secrets: Vec<Secret> = wallet.storage().load("secrets").unwrap_or_default();
    let sessions: Vec<ProviderSession> = wallet.list_sessions().unwrap_or_default();
    let knowledge: Vec<KnowledgeDoc> = wallet.storage().load("knowledge").unwrap_or_default();
    let memories: Vec<Memory> = wallet.storage().load("memories").unwrap_or_default();

    // CRITICAL
    check_sec_001(summary, &mut findings);
    check_sec_002(summary, &mut findings);
    check_sec_003(summary, &mut findings);

    // HIGH
    check_hyg_001(&secrets, &mut findings);
    check_hyg_002(&sessions, &mut findings);
    check_hyg_003(&sessions, &mut findings);
    check_hyg_004(&sessions, &mut findings);
    check_hyg_005(&secrets, &mut findings);

    // MEDIUM
    check_cfg_001(summary, &mut findings);
    check_cfg_002(summary, &mut findings);
    check_cfg_003(summary, &mut findings);
    check_cfg_004(summary, &mut findings);
    check_cfg_005(&sessions, &mut findings);

    // LOW
    check_org_001(&secrets, &mut findings);
    check_org_002(summary, &mut findings);
    check_org_003(&memories, &mut findings);
    check_org_005(&knowledge, &mut findings);

    findings.sort_by(|a, b| b.severity.cmp(&a.severity));
    findings
}

// ── CRITICAL Rules ──────────────────────────────────────────────────────────

fn check_sec_001(summary: &VaultSummary, findings: &mut Vec<Finding>) {
    if !summary.seed_encrypted {
        findings.push(Finding {
            id: "SEC-001".into(),
            severity: Severity::Critical,
            title: "Unencrypted seed file".into(),
            description: format!(
                "{}/seed is not password-protected.\n\
                 If this machine is compromised, all vault\n\
                 data is exposed.",
                summary.vault_path.display()
            ),
            fix_command: Some("said init --password".into()),
            auto_fixable: false,
        });
    }
}

fn check_sec_002(summary: &VaultSummary, findings: &mut Vec<Finding>) {
    let seed_path = summary.vault_path.join("seed");
    if let Ok(meta) = std::fs::metadata(&seed_path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = meta.permissions().mode() & 0o777;
            if mode != 0o600 {
                findings.push(Finding {
                    id: "SEC-002".into(),
                    severity: Severity::Critical,
                    title: format!("Seed file permissions too open ({:o})", mode),
                    description: format!(
                        "{}/seed should be owner-read/write-only (600).",
                        summary.vault_path.display()
                    ),
                    fix_command: Some(format!(
                        "chmod 600 {}/seed",
                        summary.vault_path.display()
                    )),
                    auto_fixable: true,
                });
            }
        }
        let _ = meta; // suppress unused warning on non-unix
    }
}

fn check_sec_003(summary: &VaultSummary, findings: &mut Vec<Finding>) {
    let data_dir = summary.vault_path.join("data");
    if let Ok(meta) = std::fs::metadata(&data_dir) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = meta.permissions().mode() & 0o777;
            if mode != 0o700 {
                findings.push(Finding {
                    id: "SEC-003".into(),
                    severity: Severity::Critical,
                    title: format!("Data directory permissions too open ({:o})", mode),
                    description: format!(
                        "{}/data/ should be owner-only (700).",
                        summary.vault_path.display()
                    ),
                    fix_command: Some(format!(
                        "chmod 700 {}/data",
                        summary.vault_path.display()
                    )),
                    auto_fixable: true,
                });
            }
        }
        let _ = meta;
    }
}

// ── HIGH Rules ──────────────────────────────────────────────────────────────

fn check_hyg_001(secrets: &[Secret], findings: &mut Vec<Finding>) {
    let unrestricted: Vec<&str> = secrets
        .iter()
        .filter(|s| s.allowed_providers.is_empty())
        .map(|s| s.name.as_str())
        .collect();

    if !unrestricted.is_empty() {
        findings.push(Finding {
            id: "HYG-001".into(),
            severity: Severity::High,
            title: format!(
                "{} secret{} ha{} no provider restrictions",
                unrestricted.len(),
                if unrestricted.len() == 1 { "" } else { "s" },
                if unrestricted.len() == 1 { "s" } else { "ve" },
            ),
            description: format!(
                "{}\n\
                 Any agent with ReadSecrets can access these.",
                quote_list(&unrestricted),
            ),
            fix_command: Some(
                "said secret set <name> --providers <list>".into(),
            ),
            auto_fixable: false,
        });
    }
}

fn check_hyg_002(sessions: &[ProviderSession], findings: &mut Vec<Finding>) {
    let all_cap: Vec<&str> = sessions
        .iter()
        .filter(|s| !s.revoked && s.capabilities.contains(&Capability::All))
        .map(|s| s.label.as_str())
        .collect();

    if !all_cap.is_empty() {
        findings.push(Finding {
            id: "HYG-002".into(),
            severity: Severity::High,
            title: format!(
                "{} session{} with All capability",
                all_cap.len(),
                if all_cap.len() == 1 { "" } else { "s" },
            ),
            description: format!(
                "{}\n\
                 Consider replacing with specific capabilities.",
                quote_list(&all_cap),
            ),
            fix_command: Some(
                "Revoke and re-grant with specific --capabilities".into(),
            ),
            auto_fixable: false,
        });
    }
}

fn check_hyg_003(sessions: &[ProviderSession], findings: &mut Vec<Finding>) {
    let now = Utc::now();
    let expired_not_revoked: Vec<&str> = sessions
        .iter()
        .filter(|s| !s.revoked && s.expires_at < now)
        .map(|s| s.label.as_str())
        .collect();

    if !expired_not_revoked.is_empty() {
        findings.push(Finding {
            id: "HYG-003".into(),
            severity: Severity::High,
            title: format!(
                "{} expired session{} not revoked",
                expired_not_revoked.len(),
                if expired_not_revoked.len() == 1 { "" } else { "s" },
            ),
            description: quote_list(&expired_not_revoked),
            fix_command: Some("said provider revoke --id <session_id>".into()),
            auto_fixable: true,
        });
    }
}

fn check_hyg_004(sessions: &[ProviderSession], findings: &mut Vec<Finding>) {
    // ProviderSession.expires_at is not Option — sessions always have an expiry.
    // However we can flag sessions with very long expiry (>365 days).
    let now = Utc::now();
    let long_lived: Vec<&str> = sessions
        .iter()
        .filter(|s| {
            !s.revoked
                && s.expires_at > now
                && (s.expires_at - now).num_days() > 365
        })
        .map(|s| s.label.as_str())
        .collect();

    if !long_lived.is_empty() {
        findings.push(Finding {
            id: "HYG-004".into(),
            severity: Severity::High,
            title: format!(
                "{} session{} with expiry >1 year",
                long_lived.len(),
                if long_lived.len() == 1 { "" } else { "s" },
            ),
            description: format!(
                "{}\n\
                 Consider shorter expiry (30d) for better hygiene.",
                quote_list(&long_lived),
            ),
            fix_command: Some(
                "Revoke and re-grant with --expires 30d".into(),
            ),
            auto_fixable: false,
        });
    }
}

fn check_hyg_005(secrets: &[Secret], findings: &mut Vec<Finding>) {
    let no_desc: Vec<&str> = secrets
        .iter()
        .filter(|s| s.description.is_none())
        .map(|s| s.name.as_str())
        .collect();

    if !no_desc.is_empty() {
        findings.push(Finding {
            id: "HYG-005".into(),
            severity: Severity::High,
            title: format!(
                "{} secret{} with no description",
                no_desc.len(),
                if no_desc.len() == 1 { "" } else { "s" },
            ),
            description: quote_list(&no_desc),
            fix_command: Some(
                "said secret set <name> --description \"...\"".into(),
            ),
            auto_fixable: false,
        });
    }
}

// ── MEDIUM Rules ────────────────────────────────────────────────────────────

fn check_cfg_001(summary: &VaultSummary, findings: &mut Vec<Finding>) {
    if !summary.daemon_running {
        findings.push(Finding {
            id: "CFG-001".into(),
            severity: Severity::Medium,
            title: "Daemon not running".into(),
            description: "AI tools cannot access your vault without the daemon.".into(),
            fix_command: Some("said daemon start".into()),
            auto_fixable: false,
        });
    }
}

fn check_cfg_002(summary: &VaultSummary, findings: &mut Vec<Finding>) {
    if summary.clients_found.is_empty() {
        findings.push(Finding {
            id: "CFG-002".into(),
            severity: Severity::Medium,
            title: "No MCP clients configured".into(),
            description: "No AI tools have SAID configured.\n\
                          Start the daemon to auto-configure: said daemon start"
                .into(),
            fix_command: Some("said daemon start".into()),
            auto_fixable: false,
        });
    }
}

fn check_cfg_003(summary: &VaultSummary, findings: &mut Vec<Finding>) {
    if summary.sessions_total == 0 {
        findings.push(Finding {
            id: "CFG-003".into(),
            severity: Severity::Medium,
            title: "No provider sessions granted".into(),
            description: "No AI providers have been granted access.\n\
                          Grant access with: said provider grant --provider <name> --capabilities <caps>"
                .into(),
            fix_command: Some(
                "said provider grant --provider anthropic --capabilities all --expires 30d"
                    .into(),
            ),
            auto_fixable: false,
        });
    }
}

fn check_cfg_004(summary: &VaultSummary, findings: &mut Vec<Finding>) {
    if summary.prompts_count == 0 {
        findings.push(Finding {
            id: "CFG-004".into(),
            severity: Severity::Medium,
            title: "No system prompt configured".into(),
            description: "Agents won't receive your portable instructions.".into(),
            fix_command: Some("said import prompts <file.json>".into()),
            auto_fixable: false,
        });
    }
}

fn check_cfg_005(sessions: &[ProviderSession], findings: &mut Vec<Finding>) {
    // Find duplicate active sessions for same provider+label
    let now = Utc::now();
    let active: Vec<&ProviderSession> = sessions
        .iter()
        .filter(|s| !s.revoked && s.expires_at > now)
        .collect();

    let mut seen: HashMap<(String, String), usize> = HashMap::new();
    for s in &active {
        let key = (format!("{:?}", s.provider), s.label.clone());
        *seen.entry(key).or_insert(0) += 1;
    }

    let dupes: Vec<String> = seen
        .iter()
        .filter(|(_, count)| **count > 1)
        .map(|((provider, label), count)| format!("{}/{} ({}x)", provider, label, count))
        .collect();

    if !dupes.is_empty() {
        findings.push(Finding {
            id: "CFG-005".into(),
            severity: Severity::Medium,
            title: "Duplicate provider sessions".into(),
            description: format!(
                "{}\n\
                 Consider revoking older duplicates.",
                dupes.join(", "),
            ),
            fix_command: Some("said provider revoke --id <session_id>".into()),
            auto_fixable: false,
        });
    }
}

// ── LOW Rules ───────────────────────────────────────────────────────────────

fn check_org_001(secrets: &[Secret], findings: &mut Vec<Finding>) {
    let no_tags: Vec<&str> = secrets
        .iter()
        .filter(|s| s.tags.is_empty())
        .map(|s| s.name.as_str())
        .collect();

    if !no_tags.is_empty() {
        findings.push(Finding {
            id: "ORG-001".into(),
            severity: Severity::Low,
            title: format!(
                "{} secret{} with no tags",
                no_tags.len(),
                if no_tags.len() == 1 { "" } else { "s" },
            ),
            description: quote_list(&no_tags),
            fix_command: Some("said secret set <name> --tags <list>".into()),
            auto_fixable: false,
        });
    }
}

fn check_org_002(summary: &VaultSummary, findings: &mut Vec<Finding>) {
    if summary.secrets_count == 0
        && summary.sessions_total == 0
        && summary.memories_count == 0
        && summary.prompts_count == 0
        && summary.knowledge_count == 0
        && summary.preferences_count == 0
        && summary.mcp_configs_count == 0
    {
        findings.push(Finding {
            id: "ORG-002".into(),
            severity: Severity::Low,
            title: "Empty vault".into(),
            description: "Your vault has no data yet.\n\
                          Get started: said secret set mykey --value sk-...\n\
                          Or import data: said import prompts <file>"
                .into(),
            fix_command: None,
            auto_fixable: false,
        });
    }
}

fn check_org_003(memories: &[Memory], findings: &mut Vec<Finding>) {
    let now = Utc::now();
    let old: Vec<&str> = memories
        .iter()
        .filter(|m| (now - m.created_at).num_days() > 90)
        .map(|m| {
            if m.content.len() > 40 {
                // We'll just note the count
                ""
            } else {
                ""
            }
        })
        .collect();

    let old_count = memories
        .iter()
        .filter(|m| (now - m.created_at).num_days() > 90)
        .count();

    if old_count > 0 {
        findings.push(Finding {
            id: "ORG-003".into(),
            severity: Severity::Low,
            title: format!(
                "{} memor{} older than 90 days",
                old_count,
                if old_count == 1 { "y" } else { "ies" },
            ),
            description: "Consider reviewing and cleaning up old memories.".into(),
            fix_command: None,
            auto_fixable: false,
        });
    }

    let _ = old; // used for count
}

fn check_org_005(knowledge: &[KnowledgeDoc], findings: &mut Vec<Finding>) {
    if knowledge.is_empty() {
        findings.push(Finding {
            id: "ORG-005".into(),
            severity: Severity::Low,
            title: "No knowledge documents".into(),
            description: "Add searchable docs: said import knowledge <file.json>".into(),
            fix_command: Some("said import knowledge <file.json>".into()),
            auto_fixable: false,
        });
    }
}

// ── Scoring ─────────────────────────────────────────────────────────────────

pub fn compute_score(findings: &[Finding]) -> u32 {
    let mut score: i32 = 100;
    for f in findings {
        match f.severity {
            Severity::Critical => score -= 20,
            Severity::High => score -= 10,
            Severity::Medium => score -= 5,
            Severity::Low => score -= 2,
        }
    }
    score.max(0) as u32
}

// ── Report Formatting ───────────────────────────────────────────────────────

pub fn build_report(wallet: &Wallet) -> AuditReport {
    let summary = index_vault(wallet);
    let findings = analyze(wallet, &summary);
    let score = compute_score(&findings);
    AuditReport {
        summary,
        findings,
        score,
    }
}

pub fn format_report(report: &AuditReport, min_severity: Severity) -> String {
    let mut out = String::new();
    let now = Utc::now();

    // Header
    out.push_str("┌─────────────────────────────────────────────────┐\n");
    out.push_str("│  GHOLA VAULT AUDIT                              │\n");
    out.push_str(&format!(
        "│  {} • {}  │\n",
        report.summary.vault_path.display(),
        now.format("%Y-%m-%d %H:%M:%S"),
    ));
    out.push_str("└─────────────────────────────────────────────────┘\n");
    out.push('\n');

    // Summary
    out.push_str("VAULT SUMMARY\n");
    out.push_str(&format!(
        "  Secrets ........... {}\n",
        report.summary.secrets_count
    ));
    out.push_str(&format!(
        "  Sessions .......... {}",
        report.summary.sessions_total
    ));
    if report.summary.sessions_expired > 0 || report.summary.sessions_revoked > 0 {
        let mut parts = Vec::new();
        if report.summary.sessions_expired > 0 {
            parts.push(format!("{} expired", report.summary.sessions_expired));
        }
        if report.summary.sessions_revoked > 0 {
            parts.push(format!("{} revoked", report.summary.sessions_revoked));
        }
        out.push_str(&format!(" ({})", parts.join(", ")));
    }
    out.push('\n');
    out.push_str(&format!(
        "  Memories .......... {}\n",
        report.summary.memories_count
    ));
    out.push_str(&format!(
        "  System Prompts .... {}\n",
        report.summary.prompts_count
    ));
    out.push_str(&format!(
        "  Knowledge Docs .... {}\n",
        report.summary.knowledge_count
    ));
    out.push_str(&format!(
        "  MCP Configs ....... {}\n",
        report.summary.mcp_configs_count
    ));
    out.push_str(&format!(
        "  Seed Encrypted .... {}\n",
        if report.summary.seed_encrypted {
            "Yes"
        } else {
            "No"
        }
    ));
    out.push_str(&format!(
        "  Daemon Running .... {}\n",
        if report.summary.daemon_running {
            format!(
                "Yes (PID {})",
                report.summary.daemon_pid.unwrap_or(0)
            )
        } else {
            "No".into()
        }
    ));
    out.push_str(&format!(
        "  Clients Found ..... {}\n",
        if report.summary.clients_found.is_empty() {
            "None".into()
        } else {
            report.summary.clients_found.join(", ")
        }
    ));

    // Findings
    let filtered: Vec<&Finding> = report
        .findings
        .iter()
        .filter(|f| f.severity >= min_severity)
        .collect();

    if filtered.is_empty() {
        out.push_str("\nNo findings at or above the selected severity.\n");
    } else {
        out.push_str("\n─── FINDINGS ──────────────────────────────────────\n\n");

        // Group by severity
        for severity in &[Severity::Critical, Severity::High, Severity::Medium, Severity::Low] {
            let group: Vec<&&Finding> = filtered.iter().filter(|f| f.severity == *severity).collect();
            if group.is_empty() {
                continue;
            }

            let label = match severity {
                Severity::Critical => "CRITICAL",
                Severity::High => "HIGH",
                Severity::Medium => "MEDIUM",
                Severity::Low => "LOW",
            };

            out.push_str(&format!(
                "  {}  {} issue{}\n\n",
                label,
                group.len(),
                if group.len() == 1 { "" } else { "s" }
            ));

            for f in &group {
                out.push_str(&format!("  {}  {}\n", f.id, f.title));
                for line in f.description.lines() {
                    out.push_str(&format!("           {}\n", line));
                }
                if let Some(fix) = &f.fix_command {
                    out.push_str(&format!("           Fix: {}\n", fix));
                }
                if f.auto_fixable {
                    out.push_str("           [auto-fixable]\n");
                }
                out.push('\n');
            }
        }
    }

    // Score
    out.push_str("─── SCORE ─────────────────────────────────────────\n\n");
    out.push_str(&format!(
        "  Credential Hygiene Score: {}/100\n\n",
        report.score
    ));

    // Progress bar
    let filled = (report.score as usize) / 4; // 25 chars total
    let empty = 25 - filled;
    out.push_str(&format!(
        "  {}{}  {}%\n\n",
        "█".repeat(filled),
        "░".repeat(empty),
        report.score,
    ));

    // Count by severity
    let critical = report
        .findings
        .iter()
        .filter(|f| f.severity == Severity::Critical)
        .count();
    let high = report
        .findings
        .iter()
        .filter(|f| f.severity == Severity::High)
        .count();
    let medium = report
        .findings
        .iter()
        .filter(|f| f.severity == Severity::Medium)
        .count();
    let low = report
        .findings
        .iter()
        .filter(|f| f.severity == Severity::Low)
        .count();

    out.push_str(&format!(
        "  {} critical • {} high • {} medium • {} low\n",
        critical, high, medium, low
    ));

    let auto_fixable = report.findings.iter().filter(|f| f.auto_fixable).count();
    if auto_fixable > 0 {
        out.push_str(&format!(
            "\n  Run `said audit --fix` to auto-apply {} safe fix{}.\n",
            auto_fixable,
            if auto_fixable == 1 { "" } else { "es" }
        ));
    }

    out
}

pub fn format_report_json(report: &AuditReport) -> String {
    serde_json::to_string_pretty(report).unwrap_or_else(|_| "{}".into())
}

// ── Auto-Fix ────────────────────────────────────────────────────────────────

pub fn apply_auto_fixes(
    wallet: &Wallet,
    findings: &[Finding],
) -> Vec<String> {
    let mut applied = Vec::new();

    for finding in findings.iter().filter(|f| f.auto_fixable) {
        match finding.id.as_str() {
            "SEC-002" => {
                let seed_path = wallet.wallet_dir().join("seed");
                if fix_file_permissions(&seed_path, 0o600) {
                    applied.push(format!("SEC-002: Set {}/seed to mode 600", wallet.wallet_dir().display()));
                }
            }
            "SEC-003" => {
                let data_path = wallet.wallet_dir().join("data");
                if fix_file_permissions(&data_path, 0o700) {
                    applied.push(format!("SEC-003: Set {}/data to mode 700", wallet.wallet_dir().display()));
                }
            }
            "HYG-003" => {
                let now = Utc::now();
                let sessions = wallet.list_sessions().unwrap_or_default();
                let mut revoked_count = 0;
                for session in &sessions {
                    if !session.revoked && session.expires_at < now {
                        if wallet.revoke_session(session.id).is_ok() {
                            revoked_count += 1;
                        }
                    }
                }
                if revoked_count > 0 {
                    applied.push(format!(
                        "HYG-003: Revoked {} expired session{}",
                        revoked_count,
                        if revoked_count == 1 { "" } else { "s" }
                    ));
                }
            }
            _ => {}
        }
    }

    applied
}

#[allow(unused_variables)]
fn fix_file_permissions(path: &PathBuf, mode: u32) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            let perms = std::fs::Permissions::from_mode(mode);
            return std::fs::set_permissions(path, perms).is_ok();
        }
        false
    }
    #[cfg(not(unix))]
    {
        false
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn quote_list(items: &[&str]) -> String {
    items
        .iter()
        .map(|s| format!("\"{}\"", s))
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn parse_severity(s: &str) -> Option<Severity> {
    match s.to_lowercase().as_str() {
        "low" => Some(Severity::Low),
        "medium" => Some(Severity::Medium),
        "high" => Some(Severity::High),
        "critical" => Some(Severity::Critical),
        _ => None,
    }
}

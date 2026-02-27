use std::collections::HashMap;
use std::path::PathBuf;

use thumper_types::flow::FlowDefinition;

/// Registry of available flow definitions.
pub struct FlowRegistry {
    flows: HashMap<String, FlowDefinition>,
}

impl FlowRegistry {
    /// Load flows from built-in definitions and user's ~/.thumper/flows/ directory.
    pub fn load() -> Self {
        let mut flows = HashMap::new();

        // Load built-in flows
        for (name, yaml) in built_in_flows() {
            match serde_yaml::from_str::<FlowDefinition>(yaml) {
                Ok(def) => {
                    flows.insert(name.to_string(), def);
                }
                Err(e) => {
                    tracing::warn!("failed to parse built-in flow '{}': {}", name, e);
                }
            }
        }

        // Load user flows from ~/.thumper/flows/
        let user_dir = user_flows_dir();
        if user_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&user_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().map_or(false, |e| e == "yaml" || e == "yml") {
                        match std::fs::read_to_string(&path) {
                            Ok(contents) => match serde_yaml::from_str::<FlowDefinition>(&contents)
                            {
                                Ok(def) => {
                                    let name = def.name.clone();
                                    tracing::info!("loaded user flow: {}", name);
                                    flows.insert(name, def);
                                }
                                Err(e) => {
                                    tracing::warn!("failed to parse {:?}: {}", path, e);
                                }
                            },
                            Err(e) => {
                                tracing::warn!("failed to read {:?}: {}", path, e);
                            }
                        }
                    }
                }
            }
        }

        tracing::info!("loaded {} flow definitions", flows.len());
        Self { flows }
    }

    pub fn get(&self, name: &str) -> Option<&FlowDefinition> {
        self.flows.get(name)
    }

    pub fn list(&self) -> Vec<FlowSummary> {
        self.flows
            .values()
            .map(|f| FlowSummary {
                name: f.name.clone(),
                description: f.description.clone(),
                params: f
                    .params
                    .iter()
                    .map(|p| FlowParamSummary {
                        name: p.name.clone(),
                        description: p.description.clone(),
                        required: p.required,
                    })
                    .collect(),
                step_count: f.steps.len(),
            })
            .collect()
    }
}

#[derive(serde::Serialize)]
pub struct FlowSummary {
    pub name: String,
    pub description: String,
    pub params: Vec<FlowParamSummary>,
    pub step_count: usize,
}

#[derive(serde::Serialize)]
pub struct FlowParamSummary {
    pub name: String,
    pub description: String,
    pub required: bool,
}

fn user_flows_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".thumper")
        .join("flows")
}

fn built_in_flows() -> Vec<(&'static str, &'static str)> {
    vec![
        ("send_token", include_str!("../flows/send_token.yaml")),
        ("swap_token", include_str!("../flows/swap_token.yaml")),
        ("check_balance", include_str!("../flows/check_balance.yaml")),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_flows_parse_successfully() {
        for (name, yaml) in built_in_flows() {
            let result = serde_yaml::from_str::<thumper_types::flow::FlowDefinition>(yaml);
            assert!(
                result.is_ok(),
                "failed to parse built-in flow '{}': {:?}",
                name,
                result.err()
            );
            let flow = result.unwrap();
            assert_eq!(flow.name, name);
            assert!(!flow.steps.is_empty(), "flow '{}' has no steps", name);
        }
    }

    #[test]
    fn flow_registry_loads_all_built_in() {
        let registry = FlowRegistry::load();
        assert!(registry.get("send_token").is_some());
        assert!(registry.get("swap_token").is_some());
        assert!(registry.get("check_balance").is_some());
        assert!(registry.get("nonexistent").is_none());
    }

    #[test]
    fn flow_registry_list_returns_all() {
        let registry = FlowRegistry::load();
        let list = registry.list();
        assert!(list.len() >= 3);

        let names: Vec<&str> = list.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"send_token"));
        assert!(names.contains(&"swap_token"));
        assert!(names.contains(&"check_balance"));
    }

    #[test]
    fn send_token_flow_has_required_params() {
        let registry = FlowRegistry::load();
        let flow = registry.get("send_token").unwrap();
        assert_eq!(flow.params.len(), 3); // recipient, amount, token

        let recipient = flow.params.iter().find(|p| p.name == "recipient").unwrap();
        assert!(recipient.required);
        assert!(recipient.default.is_none());

        let amount = flow.params.iter().find(|p| p.name == "amount").unwrap();
        assert!(amount.required);

        let token = flow.params.iter().find(|p| p.name == "token").unwrap();
        assert!(!token.required);
        assert_eq!(token.default.as_deref(), Some("SOL"));
    }

    #[test]
    fn check_balance_flow_has_no_params() {
        let registry = FlowRegistry::load();
        let flow = registry.get("check_balance").unwrap();
        assert!(flow.params.is_empty());
        assert_eq!(flow.steps.len(), 3);
    }

    #[test]
    fn flow_summary_includes_step_count() {
        let registry = FlowRegistry::load();
        let list = registry.list();
        for summary in &list {
            assert!(summary.step_count > 0);
            assert!(!summary.description.is_empty());
        }
    }
}

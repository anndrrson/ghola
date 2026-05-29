use std::collections::{HashMap, HashSet, VecDeque};

/// Session memory that tracks recent actions, screens, and per-app knowledge.
pub struct SessionMemory {
    /// Last 100 actions performed.
    actions: VecDeque<ActionRecord>,
    /// Last 5 screen snapshots.
    recent_screens: VecDeque<ScreenSnapshot>,
    /// Per-app accumulated knowledge.
    app_knowledge: HashMap<String, AppKnowledge>,
    /// Currently foregrounded app package.
    pub current_app: Option<String>,
}

/// A single recorded action.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ActionRecord {
    /// Milliseconds since Unix epoch.
    pub timestamp: u64,
    /// Tool name (e.g., "device_tap").
    pub tool_name: String,
    /// Short summary of the params (e.g., "text='Send'").
    pub params_summary: String,
    /// Whether the action succeeded.
    pub success: bool,
    /// App package when the action was performed.
    pub app_package: Option<String>,
    /// How long the action took in milliseconds.
    pub duration_ms: u64,
}

/// A snapshot of the screen state at a point in time.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ScreenSnapshot {
    /// Milliseconds since Unix epoch.
    pub timestamp: u64,
    /// App package name.
    pub package: String,
    /// Activity name (if available).
    pub activity: Option<String>,
    /// Number of nodes in the accessibility tree.
    pub node_count: usize,
    /// First 20 text values from visible nodes.
    pub key_texts: Vec<String>,
}

/// Accumulated knowledge about a specific app.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AppKnowledge {
    /// Android package name.
    pub package: String,
    /// Human-readable app label (if discovered).
    pub label: Option<String>,
    /// Last time the app was opened (millis since epoch).
    pub last_opened: u64,
    /// Set of known activity names.
    pub known_activities: HashSet<String>,
    /// Exponential moving average of app load time in ms.
    pub typical_load_time_ms: Option<f64>,
}

const MAX_ACTIONS: usize = 100;
const MAX_SCREENS: usize = 5;

impl SessionMemory {
    pub fn new() -> Self {
        Self {
            actions: VecDeque::new(),
            recent_screens: VecDeque::new(),
            app_knowledge: HashMap::new(),
            current_app: None,
        }
    }

    /// Record a completed action.
    pub fn record_action(&mut self, record: ActionRecord) {
        self.actions.push_front(record);
        if self.actions.len() > MAX_ACTIONS {
            self.actions.pop_back();
        }
    }

    /// Record a screen snapshot and update app knowledge.
    pub fn record_screen(&mut self, snapshot: ScreenSnapshot) {
        // Update current app
        self.current_app = Some(snapshot.package.clone());

        // Update app knowledge
        let knowledge = self
            .app_knowledge
            .entry(snapshot.package.clone())
            .or_insert_with(|| AppKnowledge {
                package: snapshot.package.clone(),
                label: None,
                last_opened: snapshot.timestamp,
                known_activities: HashSet::new(),
                typical_load_time_ms: None,
            });
        knowledge.last_opened = snapshot.timestamp;
        if let Some(ref activity) = snapshot.activity {
            knowledge.known_activities.insert(activity.clone());
        }

        self.recent_screens.push_front(snapshot);
        if self.recent_screens.len() > MAX_SCREENS {
            self.recent_screens.pop_back();
        }
    }

    /// Get the last N action records.
    pub fn recent_actions(&self, n: usize) -> Vec<&ActionRecord> {
        self.actions.iter().take(n).collect()
    }

    /// Update the exponential moving average of app load time.
    /// Uses alpha = 0.3 for the new sample.
    pub fn update_load_time(&mut self, package: &str, ms: u64) {
        let knowledge = self
            .app_knowledge
            .entry(package.to_string())
            .or_insert_with(|| AppKnowledge {
                package: package.to_string(),
                label: None,
                last_opened: now_millis(),
                known_activities: HashSet::new(),
                typical_load_time_ms: None,
            });

        let alpha = 0.3;
        let new_ms = ms as f64;
        knowledge.typical_load_time_ms = Some(match knowledge.typical_load_time_ms {
            Some(current) => current * (1.0 - alpha) + new_ms * alpha,
            None => new_ms,
        });
    }

    /// Get knowledge about all known apps.
    pub fn all_app_knowledge(&self) -> &HashMap<String, AppKnowledge> {
        &self.app_knowledge
    }

    /// Get the most recent screen snapshot.
    pub fn last_screen(&self) -> Option<&ScreenSnapshot> {
        self.recent_screens.front()
    }
}

impl Default for SessionMemory {
    fn default() -> Self {
        Self::new()
    }
}

/// Current time in milliseconds since epoch.
pub fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

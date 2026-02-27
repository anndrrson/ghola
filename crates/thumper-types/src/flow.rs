use serde::{Deserialize, Serialize};

use crate::command::{NodeSelector, ScrollDirection};

/// A complete flow definition — a scripted sequence of device actions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowDefinition {
    pub name: String,
    pub description: String,
    /// Parameters the flow accepts (for template interpolation).
    #[serde(default)]
    pub params: Vec<FlowParam>,
    pub steps: Vec<FlowStep>,
}

/// A parameter declaration for a flow.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowParam {
    pub name: String,
    pub description: String,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
}

/// A single step in a flow.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowStep {
    /// Human-readable label for this step.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// The action to perform.
    pub action: FlowAction,
    /// Optional condition to wait for after the action completes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait_for: Option<WaitCondition>,
    /// What to do if this step fails.
    #[serde(default)]
    pub on_failure: FailureStrategy,
    /// Override timeout for this step in milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

/// Actions that can be performed in a flow step.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum FlowAction {
    LaunchApp { package: String },
    Tap { selector: NodeSelector },
    LongPress { selector: NodeSelector, duration_ms: Option<u64> },
    TypeText { selector: NodeSelector, value: String },
    Swipe { from: [i32; 2], to: [i32; 2], duration_ms: Option<u64> },
    Scroll { selector: Option<NodeSelector>, direction: ScrollDirection },
    WaitFor { selector: NodeSelector, timeout_ms: u64 },
    PressBack,
    ReadScreen,
    Delay { ms: u64 },
}

/// Condition to wait for after a flow step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaitCondition {
    pub selector: NodeSelector,
    #[serde(default = "default_wait_timeout")]
    pub timeout_ms: u64,
    #[serde(default = "default_poll_interval")]
    pub poll_interval_ms: u64,
}

fn default_wait_timeout() -> u64 {
    10000
}

fn default_poll_interval() -> u64 {
    500
}

/// Strategy for handling step failures.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureStrategy {
    Abort,
    Skip,
    Retry { max_attempts: u32, delay_ms: u64 },
}

impl Default for FailureStrategy {
    fn default() -> Self {
        Self::Abort
    }
}

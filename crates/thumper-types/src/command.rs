use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Top-level envelope for all messages between MCP server, relay, and device.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    /// Unique correlation ID for request/response matching.
    pub id: String,
    /// Unix timestamp in milliseconds.
    pub timestamp: u64,
    /// The message payload.
    pub message: MessageType,
    /// Source device pubkey (set by relay on routing).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Target device pubkey.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// When true, the device should execute the action and return immediately
    /// without waiting for screen changes or reading the accessibility tree.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub skip_wait: bool,
}

impl Envelope {
    pub fn new(message: MessageType) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            message,
            source: None,
            target: None,
            skip_wait: false,
        }
    }

    pub fn with_target(mut self, target: String) -> Self {
        self.target = Some(target);
        self
    }

    pub fn with_source(mut self, source: String) -> Self {
        self.source = Some(source);
        self
    }

    pub fn with_skip_wait(mut self, skip: bool) -> Self {
        self.skip_wait = skip;
        self
    }

    /// Create a response envelope that preserves the correlation ID.
    pub fn response(&self, message: MessageType) -> Self {
        Self {
            id: self.id.clone(),
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            message,
            source: self.target.clone(),
            target: self.source.clone(),
            skip_wait: false,
        }
    }
}

/// All message types exchanged between components.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum MessageType {
    // Phase 1 commands (MCP → device)
    ReadScreen,
    Tap(NodeSelector),
    TypeText(TypeTextPayload),
    LaunchApp(LaunchAppPayload),
    PressBack,
    Swipe(SwipePayload),

    // Phase 2A commands
    TakeScreenshot(ScreenshotParams),
    LongPress(LongPressPayload),
    Scroll(ScrollPayload),
    GlobalAction(GlobalActionPayload),
    SetClipboard(ClipboardSetPayload),
    GetClipboard,
    GetDeviceInfo,
    ListInstalledApps,
    WaitFor(WaitForPayload),

    // Phase 2B commands
    ExecuteFlow(FlowExecutePayload),

    // Phase 2D — Notifications
    ReadNotifications(ReadNotificationsPayload),
    DismissNotification(DismissNotificationPayload),

    // Phase 2C
    ListConnectedDevices,

    // Phase 1 responses (device → MCP)
    ScreenState(ScreenState),
    ActionResult(ActionResult),
    Error(ErrorPayload),

    // Phase 2A responses
    ScreenshotResult(ScreenshotResult),
    ClipboardResult(ClipboardResult),
    DeviceInfoResult(DeviceInfo),
    InstalledAppsResult(InstalledAppsResult),
    WaitForResult(WaitForResult),

    // Phase 2B responses
    FlowProgress(FlowProgress),
    FlowResult(FlowResult),

    // Phase 2D responses
    NotificationsResult(NotificationsResult),

    // Phase 2C responses
    ConnectedDevicesResult(ConnectedDevicesResult),

    // GPU Compute messages
    InferenceRequest(InferenceRequestPayload),
    InferenceResponse(InferenceResponsePayload),
    InferenceStreamChunk(InferenceStreamChunk),
    InferenceStreamEnd(InferenceStreamEnd),
    ProviderHeartbeat(ProviderHeartbeatPayload),
    ProviderAdvertise(ProviderAdvertisePayload),
    ProviderAdvertiseAck(ProviderAdvertiseAck),

    // Keepalive
    Ping,
    Pong,
}

/// Selector for finding a UI node on the device screen.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeSelector {
    /// Exact text match.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Partial text match.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_contains: Option<String>,
    /// Content description match.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desc: Option<String>,
    /// Content description partial match.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desc_contains: Option<String>,
    /// Android resource ID (e.g., "com.example:id/button_send").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    /// Class name (e.g., "android.widget.Button").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub class: Option<String>,
    /// Only match clickable nodes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clickable: Option<bool>,
    /// Screen coordinates [x, y] — fallback when no semantic match.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coordinates: Option<[i32; 2]>,
}

/// Payload for typing text into a UI element.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TypeTextPayload {
    /// Selector for the target input field.
    pub selector: NodeSelector,
    /// Text to type.
    pub text: String,
}

/// Payload for launching an app.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchAppPayload {
    /// Android package name (e.g., "app.phantom").
    pub package: String,
}

/// Payload for swiping on the screen.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwipePayload {
    /// Start coordinates [x, y].
    pub from: [i32; 2],
    /// End coordinates [x, y].
    pub to: [i32; 2],
    /// Duration in milliseconds (default 300).
    #[serde(default = "default_swipe_duration")]
    pub duration_ms: u64,
}

fn default_swipe_duration() -> u64 {
    300
}

/// Parsed accessibility tree from the device screen.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenState {
    /// Current app package name.
    pub package: String,
    /// Current activity name (if available).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<String>,
    /// Flat list of visible UI nodes.
    pub nodes: Vec<UiNode>,
}

/// A single UI node from the accessibility tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiNode {
    /// Node index in the tree.
    pub index: u32,
    /// Class name (e.g., "android.widget.TextView").
    pub class: String,
    /// Visible text content.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Content description for accessibility.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desc: Option<String>,
    /// Android resource ID.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    /// Bounding rectangle [left, top, right, bottom].
    pub bounds: [i32; 4],
    /// Whether this node is clickable.
    pub clickable: bool,
    /// Whether this node is focusable.
    pub focusable: bool,
    /// Whether this node is editable.
    pub editable: bool,
    /// Whether this node is checked (for checkboxes/toggles).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
    /// Whether this node is enabled.
    pub enabled: bool,
    /// Whether this node is scrollable.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub scrollable: bool,
    /// Whether this node supports long click.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub long_clickable: bool,
    /// Depth in the UI tree (for structure context).
    pub depth: u32,
}

/// Result of an action execution on the device.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Screen state after action (if requested).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen_after: Option<ScreenState>,
}

/// Error details from the device.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
}

// -- Phase 2A payloads --

/// Parameters for screenshot capture.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenshotParams {
    /// Scale factor (0.25-1.0). Lower = smaller/faster. Default 0.5.
    #[serde(default = "default_screenshot_scale")]
    pub scale: f64,
    /// JPEG quality (1-100). Default 50.
    #[serde(default = "default_screenshot_quality")]
    pub quality: u32,
}

fn default_screenshot_scale() -> f64 {
    0.75
}

fn default_screenshot_quality() -> u32 {
    70
}

impl Default for ScreenshotParams {
    fn default() -> Self {
        Self {
            scale: default_screenshot_scale(),
            quality: default_screenshot_quality(),
        }
    }
}

/// Screenshot result with base64-encoded JPEG.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenshotResult {
    /// Base64-encoded JPEG image data.
    pub image_base64: String,
    /// MIME type (always "image/jpeg").
    pub mime_type: String,
    /// Image width in pixels.
    pub width: u32,
    /// Image height in pixels.
    pub height: u32,
}

/// Long press action payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LongPressPayload {
    /// Target element selector.
    pub selector: NodeSelector,
    /// Hold duration in milliseconds (default 500).
    #[serde(default = "default_long_press_duration")]
    pub duration_ms: u64,
}

fn default_long_press_duration() -> u64 {
    500
}

/// Scroll action payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScrollPayload {
    /// Target scrollable element (optional — scrolls the first scrollable if omitted).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selector: Option<NodeSelector>,
    /// Scroll direction.
    pub direction: ScrollDirection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

/// Global device action payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalActionPayload {
    pub action: GlobalAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GlobalAction {
    Home,
    Recents,
    Notifications,
    QuickSettings,
    PowerDialog,
}

/// Set clipboard text.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipboardSetPayload {
    pub text: String,
}

/// Clipboard read result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipboardResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// Device information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub model: String,
    pub manufacturer: String,
    pub android_version: String,
    pub sdk_version: u32,
    pub screen_width: u32,
    pub screen_height: u32,
    pub screen_density: f64,
    pub battery_level: u32,
    pub battery_charging: bool,
    pub wifi_connected: bool,
    pub cellular_connected: bool,
}

/// Result of listing installed apps.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledAppsResult {
    pub apps: Vec<InstalledApp>,
}

/// An installed app entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledApp {
    pub package: String,
    pub label: String,
}

/// Wait-for condition payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaitForPayload {
    /// Selector to wait for.
    pub selector: NodeSelector,
    /// Maximum time to wait in milliseconds (default 10000).
    #[serde(default = "default_wait_timeout")]
    pub timeout_ms: u64,
    /// Polling interval in milliseconds (default 500).
    #[serde(default = "default_poll_interval")]
    pub poll_interval_ms: u64,
}

fn default_wait_timeout() -> u64 {
    10000
}

fn default_poll_interval() -> u64 {
    500
}

/// Wait-for condition result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaitForResult {
    pub found: bool,
    pub elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen: Option<ScreenState>,
}

// -- Phase 2B payloads --

/// Payload to execute a flow on the device.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowExecutePayload {
    pub flow: crate::flow::FlowDefinition,
    /// Parameter values for template interpolation.
    #[serde(default)]
    pub params: std::collections::HashMap<String, String>,
}

/// Progress update during flow execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowProgress {
    pub step: u32,
    pub total: u32,
    pub action: String,
    pub status: String,
}

/// Final result of a flow execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowResult {
    pub success: bool,
    pub steps_completed: u32,
    pub total_steps: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_screen: Option<ScreenState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Index of the step that failed (0-based), for error debugging.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_step: Option<u32>,
    /// Base64-encoded JPEG screenshot captured at the point of failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_screenshot: Option<String>,
}

// -- Phase 2C payloads --

/// List of connected devices.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectedDevicesResult {
    pub devices: Vec<ConnectedDevice>,
}

/// A connected device entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectedDevice {
    pub pubkey: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

// -- Phase 2D payloads (Notifications) --

/// Read recent notifications payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadNotificationsPayload {
    /// Maximum number of notifications to return (default 20).
    #[serde(default = "default_notification_limit")]
    pub limit: u32,
}

fn default_notification_limit() -> u32 {
    20
}

/// Dismiss a notification payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DismissNotificationPayload {
    /// Notification key to dismiss.
    pub key: String,
}

/// A single notification entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationEntry {
    pub key: String,
    pub package: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub timestamp: u64,
}

/// Result of reading notifications.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationsResult {
    pub notifications: Vec<NotificationEntry>,
}

// -- GPU Compute payloads --

/// A chat message in OpenAI-compatible format for inference requests.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceChatMessage {
    pub role: String,
    pub content: String,
}

/// Request payload sent to a GPU provider for inference.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceRequestPayload {
    pub job_id: String,
    pub model_id: String,
    pub messages: Vec<InferenceChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    #[serde(default)]
    pub stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
}

fn default_max_tokens() -> u32 {
    2048
}

/// Response payload from a GPU provider for non-streaming inference.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceResponsePayload {
    pub job_id: String,
    pub text: String,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub latency_ms: u64,
}

/// A streaming chunk from a GPU provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceStreamChunk {
    pub job_id: String,
    pub text: String,
    pub tokens_so_far: u32,
}

/// End-of-stream marker from a GPU provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferenceStreamEnd {
    pub job_id: String,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub latency_ms: u64,
}

/// Heartbeat sent periodically by a GPU provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderHeartbeatPayload {
    pub active_jobs: u32,
    pub models: Vec<String>,
    pub vram_free_mb: Option<u32>,
}

/// Model info advertised by a GPU provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderModelInfo {
    pub model_id: String,
    pub context_length: u32,
    /// Price per 1K input tokens in micro-USDC.
    pub price_per_1k_input: u64,
    /// Price per 1K output tokens in micro-USDC.
    pub price_per_1k_output: u64,
}

/// Advertisement sent by a GPU provider after connecting.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderAdvertisePayload {
    pub name: String,
    pub models: Vec<ProviderModelInfo>,
    pub vram_mb: u32,
    pub max_concurrent: u32,
    pub wallet_address: String,
}

/// Acknowledgement sent back to a GPU provider after successful registration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderAdvertiseAck {
    pub accepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

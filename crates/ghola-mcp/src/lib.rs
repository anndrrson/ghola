mod config;
mod connection;
mod flows;
mod memory;
mod tools;

use std::sync::Arc;
use std::time::Duration;

use rmcp::{
    handler::server::{tool::ToolRouter, wrapper::Parameters},
    model::*,
    tool, tool_handler, tool_router,
    transport::stdio,
    ErrorData, ServerHandler, ServiceExt,
};
use schemars::JsonSchema;
use serde::Deserialize;
use tokio::sync::Mutex;

use ghola_assistant_types::*;

use crate::config::ThumperConfig;
use crate::connection::RelayConnection;
use crate::flows::FlowRegistry;
use crate::memory::SessionMemory;

pub struct ThumperServer {
    connection: Arc<Mutex<Option<RelayConnection>>>,
    config: ThumperConfig,
    flow_registry: FlowRegistry,
    memory: Arc<Mutex<SessionMemory>>,
    device_profile: Arc<Mutex<Option<DeviceInfo>>>,
    tool_router: ToolRouter<Self>,
}

// -- Tool parameter types --

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DeviceStatusParams {}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReadScreenParams {
    /// Target device pubkey (optional -- defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TapParams {
    /// Exact text on the element to tap.
    pub text: Option<String>,
    /// Partial text match.
    pub text_contains: Option<String>,
    /// Content description to match.
    pub desc: Option<String>,
    /// Content description partial match.
    pub desc_contains: Option<String>,
    /// Android resource ID to match.
    pub resource_id: Option<String>,
    /// Screen coordinates [x, y] as fallback.
    pub coordinates: Option<[i32; 2]>,
    /// If true, wait for the screen to stabilize after the action and return updated screen state. If false (default), return immediately — much faster, but screen_after will be null. Use device_read_screen separately if you need the screen.
    pub wait: Option<bool>,
    /// Target device pubkey (optional -- defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TypeTextParams {
    /// Text to type into the field.
    pub text: String,
    /// Exact text on the input field.
    pub field_text: Option<String>,
    /// Content description of the input field.
    pub field_desc: Option<String>,
    /// Content description partial match for the input field.
    pub field_desc_contains: Option<String>,
    /// Resource ID of the input field.
    pub field_resource_id: Option<String>,
    /// If true, wait for the screen to stabilize after the action and return updated screen state. If false (default), return immediately — much faster, but screen_after will be null. Use device_read_screen separately if you need the screen.
    pub wait: Option<bool>,
    /// Target device pubkey (optional -- defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct LaunchAppParams {
    /// Android package name (e.g., "app.phantom").
    pub package: String,
    /// If true, wait for the screen to stabilize after the action and return updated screen state. If false (default), return immediately — much faster, but screen_after will be null. Use device_read_screen separately if you need the screen.
    pub wait: Option<bool>,
    /// Target device pubkey (optional -- defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct PressBackParams {
    /// If true, wait for the screen to stabilize after the action and return updated screen state. If false (default), return immediately — much faster, but screen_after will be null. Use device_read_screen separately if you need the screen.
    pub wait: Option<bool>,
    /// Target device pubkey (optional -- defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SwipeParams {
    /// Direction to swipe: "up", "down", "left", "right".
    pub direction: String,
    /// Swipe distance as fraction of screen (0.0-1.0, default 0.5).
    pub distance: Option<f64>,
    /// Swipe duration in milliseconds (default 300).
    pub duration_ms: Option<u64>,
    /// If true, wait for the screen to stabilize after the action and return updated screen state. If false (default), return immediately — much faster, but screen_after will be null. Use device_read_screen separately if you need the screen.
    pub wait: Option<bool>,
    /// Target device pubkey (optional -- defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ScreenshotToolParams {
    /// Scale factor (0.25-1.0). Lower = smaller file, faster transfer. Default 0.75.
    pub scale: Option<f64>,
    /// JPEG quality (1-100). Default 70.
    pub quality: Option<u32>,
    /// Target device pubkey (optional -- defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct LongPressParams {
    /// Exact text on the element to long press.
    pub text: Option<String>,
    /// Partial text match.
    pub text_contains: Option<String>,
    /// Content description to match.
    pub desc: Option<String>,
    /// Content description partial match.
    pub desc_contains: Option<String>,
    /// Android resource ID to match.
    pub resource_id: Option<String>,
    /// Screen coordinates [x, y] as fallback.
    pub coordinates: Option<[i32; 2]>,
    /// Hold duration in milliseconds (default 500).
    pub duration_ms: Option<u64>,
    /// If true, wait for the screen to stabilize after the action and return updated screen state. If false (default), return immediately — much faster, but screen_after will be null. Use device_read_screen separately if you need the screen.
    pub wait: Option<bool>,
    /// Target device pubkey (optional -- defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ScrollParams {
    /// Direction to scroll the content: "up", "down", "left", "right".
    pub direction: String,
    /// Exact text on the scrollable container (optional).
    pub container_text: Option<String>,
    /// Resource ID of the scrollable container (optional).
    pub container_resource_id: Option<String>,
    /// If true, wait for the screen to stabilize after the action and return updated screen state. If false (default), return immediately — much faster, but screen_after will be null. Use device_read_screen separately if you need the screen.
    pub wait: Option<bool>,
    /// Target device pubkey (optional -- defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GlobalActionParams {
    /// Action to perform: "home", "recents", "notifications", "quick_settings", "power_dialog".
    pub action: String,
    /// If true, wait for the screen to stabilize after the action and return updated screen state. If false (default), return immediately — much faster, but screen_after will be null. Use device_read_screen separately if you need the screen.
    pub wait: Option<bool>,
    /// Target device pubkey (optional -- defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ClipboardSetParams {
    /// Text to copy to the clipboard.
    pub text: String,
    /// Target device pubkey (optional -- defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ClipboardGetParams {
    /// Target device pubkey (optional -- defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DeviceInfoParams {
    /// Target device pubkey (optional -- defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ListAppsParams {
    /// Target device pubkey (optional -- defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct WaitForParams {
    /// Exact text to wait for.
    pub text: Option<String>,
    /// Partial text to wait for.
    pub text_contains: Option<String>,
    /// Content description to wait for.
    pub desc: Option<String>,
    /// Content description partial match to wait for.
    pub desc_contains: Option<String>,
    /// Resource ID to wait for.
    pub resource_id: Option<String>,
    /// Maximum wait time in milliseconds (default 10000).
    pub timeout_ms: Option<u64>,
    /// Polling interval in milliseconds (default 500).
    pub poll_interval_ms: Option<u64>,
    /// Target device pubkey (optional -- defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ExecuteFlowParams {
    /// Name of the flow to execute (from device_list_flows).
    pub flow_name: String,
    /// Parameter values for the flow (key-value pairs).
    pub params: Option<std::collections::HashMap<String, String>>,
    /// Target device pubkey (optional -- defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ListFlowsParams {}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ListDevicesParams {}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReadNotificationsParams {
    /// Maximum number of notifications to return (default 20).
    pub limit: Option<u32>,
    /// Target device pubkey (optional -- defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DismissNotificationParams {
    /// Notification key to dismiss (from device_read_notifications).
    pub key: String,
    /// Target device pubkey (optional -- defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DeviceHistoryParams {
    /// Number of recent actions to return (default 20, max 100).
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SmartReadParams {
    /// Target device pubkey (optional -- defaults to configured device).
    pub device: Option<String>,
}

// -- Tool implementations --

#[tool_router]
impl ThumperServer {
    pub fn new(config: ThumperConfig, connection: Option<RelayConnection>) -> Self {
        let flow_registry = FlowRegistry::load();
        Self {
            connection: Arc::new(Mutex::new(connection)),
            config,
            flow_registry,
            memory: Arc::new(Mutex::new(SessionMemory::new())),
            device_profile: Arc::new(Mutex::new(None)),
            tool_router: Self::tool_router(),
        }
    }

    // ===== Phase 1 tools =====

    #[tool(
        name = "device_status",
        description = "Check whether the device is connected and reachable via the relay. Returns the connection status, relay URL, and configured device pubkey. Call this first to verify connectivity before sending commands."
    )]
    async fn device_status(
        &self,
        Parameters(params): Parameters<DeviceStatusParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::phase1::device_status(self, params).await
    }

    #[tool(
        name = "device_read_screen",
        description = "Read the device screen and return the UI accessibility tree as structured JSON. Returns all visible UI elements with their text, descriptions, bounds, and interactive properties. Call this first to understand what's on screen before taking any action."
    )]
    async fn device_read_screen(
        &self,
        Parameters(params): Parameters<ReadScreenParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::phase1::device_read_screen(self, params).await
    }

    #[tool(
        name = "device_tap",
        description = "Tap a UI element on the device screen. Specify the element using one or more selectors:\n- text: exact visible text (e.g., \"Send\", \"OK\")\n- text_contains: partial text match (e.g., \"Confirm\" matches \"Confirm Transaction\")\n- desc: accessibility content description\n- resource_id: Android resource ID (e.g., \"com.app:id/btn_send\")\n- coordinates: [x, y] pixel position as fallback\nBy default returns immediately after executing the tap (fast, ~50ms). Set wait=true to wait for the screen to stabilize and return the updated screen state. Use device_read_screen first to find the right selector."
    )]
    async fn device_tap(
        &self,
        Parameters(params): Parameters<TapParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::phase1::device_tap(self, params).await
    }

    #[tool(
        name = "device_type_text",
        description = "Type text into an input field on the device screen. Identify the target field using field_text, field_desc, field_desc_contains, or field_resource_id. The field must be editable (input field, search box, etc.). If multiple editable fields exist, be specific with your selector. By default returns immediately after typing (fast). Set wait=true to return updated screen state."
    )]
    async fn device_type_text(
        &self,
        Parameters(params): Parameters<TypeTextParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::phase1::device_type_text(self, params).await
    }

    #[tool(
        name = "device_launch_app",
        description = "Launch an Android app on the device by its package name (e.g., 'app.phantom' for Phantom wallet, 'com.google.android.apps.maps' for Maps). By default returns immediately after launching (fast). Set wait=true to wait for the app to load and return screen state."
    )]
    async fn device_launch_app(
        &self,
        Parameters(params): Parameters<LaunchAppParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::phase1::device_launch_app(self, params).await
    }

    #[tool(
        name = "device_press_back",
        description = "Press the Android back button. Useful for closing dialogs, going back in navigation, or dismissing keyboards. By default returns immediately (fast). Set wait=true to return updated screen state."
    )]
    async fn device_press_back(
        &self,
        Parameters(params): Parameters<PressBackParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::phase1::device_press_back(self, params).await
    }

    #[tool(
        name = "device_swipe",
        description = "Swipe on the device screen in a direction (up/down/left/right). Use 'up' to scroll down through content, 'down' to scroll up (finger drag direction). The 'distance' parameter (0.0-1.0, default 0.5) controls swipe length as a fraction of screen size. By default returns immediately (fast). Set wait=true to return updated screen state. For scrolling scrollable containers, prefer device_scroll which uses accessibility APIs and is more reliable."
    )]
    async fn device_swipe(
        &self,
        Parameters(params): Parameters<SwipeParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::phase1::device_swipe(self, params).await
    }

    // ===== Phase 2A tools =====

    #[tool(
        name = "device_screenshot",
        description = "Take a screenshot of the device screen and return it as a JPEG image. Use this when the accessibility tree (device_read_screen) doesn't provide enough context -- e.g., for visual elements like icons, images, charts, maps, or complex layouts. The 'scale' parameter (0.25-1.0, default 0.75) and 'quality' (1-100, default 70) control file size. Lower values = faster transfer. Typical screenshot is ~40KB. More expensive than read_screen but gives full visual context."
    )]
    async fn device_screenshot(
        &self,
        Parameters(params): Parameters<ScreenshotToolParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::phase2a::device_screenshot(self, params).await
    }

    #[tool(
        name = "device_long_press",
        description = "Long press a UI element to trigger context menus, drag operations, or selection mode. Specify the element using the same selectors as device_tap (text, desc, resource_id, coordinates). The 'duration_ms' parameter controls hold time (default 500ms, increase to 1000-2000ms for drag operations). By default returns immediately (fast). Set wait=true to return updated screen state."
    )]
    async fn device_long_press(
        &self,
        Parameters(params): Parameters<LongPressParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::phase2a::device_long_press(self, params).await
    }

    #[tool(
        name = "device_scroll",
        description = "Scroll a scrollable view up, down, left, or right using accessibility actions. More reliable than swipe for scrolling lists and containers. Optionally target a specific scrollable container by text or resource ID. By default returns immediately (fast). Set wait=true to return updated screen state."
    )]
    async fn device_scroll(
        &self,
        Parameters(params): Parameters<ScrollParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::phase2a::device_scroll(self, params).await
    }

    #[tool(
        name = "device_global_action",
        description = "Perform a global device action: 'home' (go to home screen), 'recents' (open recent apps), 'notifications' (pull down notification shade), 'quick_settings' (open quick settings), or 'power_dialog' (show power menu). By default returns immediately (fast). Set wait=true to return updated screen state."
    )]
    async fn device_global_action(
        &self,
        Parameters(params): Parameters<GlobalActionParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::phase2a::device_global_action(self, params).await
    }

    #[tool(
        name = "device_clipboard_set",
        description = "Copy text to the device clipboard. Useful for pasting addresses, amounts, or other data into apps."
    )]
    async fn device_clipboard_set(
        &self,
        Parameters(params): Parameters<ClipboardSetParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::phase2a::device_clipboard_set(self, params).await
    }

    #[tool(
        name = "device_clipboard_get",
        description = "Read the current text from the device clipboard."
    )]
    async fn device_clipboard_get(
        &self,
        Parameters(params): Parameters<ClipboardGetParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::phase2a::device_clipboard_get(self, params).await
    }

    #[tool(
        name = "device_info",
        description = "Get device information including battery level, screen dimensions, Android version, connectivity status, and hardware details. Useful for understanding the device context before performing actions."
    )]
    async fn device_info(
        &self,
        Parameters(params): Parameters<DeviceInfoParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::phase2a::device_info(self, params).await
    }

    #[tool(
        name = "device_list_apps",
        description = "List all installed apps on the device with their package names and display labels. Useful for finding the correct package name to use with device_launch_app."
    )]
    async fn device_list_apps(
        &self,
        Parameters(params): Parameters<ListAppsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::phase2a::device_list_apps(self, params).await
    }

    #[tool(
        name = "device_wait_for",
        description = "Wait for a UI element matching the selector to appear on screen. Polls the accessibility tree at regular intervals until the element is found or timeout is reached. Returns {found: bool, elapsed_ms, screen}. Use this after actions that trigger loading or async transitions -- e.g., after tapping 'Send', wait for text_contains='Confirmed'. Parameters: timeout_ms (default 10000), poll_interval_ms (default 500). Selectors: same as device_tap (text, text_contains, desc, resource_id)."
    )]
    async fn device_wait_for(
        &self,
        Parameters(params): Parameters<WaitForParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::phase2a::device_wait_for(self, params).await
    }

    // ===== Phase 2B tools =====

    #[tool(
        name = "device_execute_flow",
        description = "Execute a pre-defined multi-step flow on the device. Flows are scripted sequences of actions (tap, type, wait, etc.) that run entirely on-device with zero AI cost per step. Use device_list_flows to see available flows and their parameters.\n\nBuilt-in flows:\n- send_token: Send SPL tokens via Phantom (params: recipient, amount, token)\n- swap_token: Swap tokens via Phantom (params: from_token, to_token, amount)\n- check_balance: Read Phantom wallet balances (no params)\n- open_dapp_store: Open the Solana dApp Store (params: search [optional])\n\nReturns {success, steps_completed, total_steps, final_screen, error, failed_step}. On failure, failed_step indicates which step (0-based) failed."
    )]
    async fn device_execute_flow(
        &self,
        Parameters(params): Parameters<ExecuteFlowParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::phase2b::device_execute_flow(self, params).await
    }

    #[tool(
        name = "device_list_flows",
        description = "List all available flow definitions with their names, descriptions, parameters, and step counts. Includes built-in flows (send_token, swap_token, check_balance) and any user-defined flows from ~/.thumper/flows/*.yaml. Each flow entry shows required/optional parameters and their descriptions."
    )]
    async fn device_list_flows(
        &self,
        Parameters(params): Parameters<ListFlowsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::phase2b::device_list_flows(self, params).await
    }

    // ===== Phase 2C tools =====

    #[tool(
        name = "device_list_devices",
        description = "List all devices currently connected to the relay. Returns each device's pubkey and label (if available). Use the pubkey as the 'device' parameter on other tools to target a specific device."
    )]
    async fn device_list_devices(
        &self,
        Parameters(params): Parameters<ListDevicesParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::phase2cd::device_list_devices(self, params).await
    }

    // ===== Phase 2D tools (Notifications) =====

    #[tool(
        name = "device_read_notifications",
        description = "Read recent notifications from the device. Returns [{key, package, title, text, timestamp}] for each notification. The 'limit' parameter controls how many to return (default 20, max 50). Use the 'key' field with device_dismiss_notification to clear specific notifications. Common uses: checking transaction confirmations, reading incoming messages, monitoring app alerts."
    )]
    async fn device_read_notifications(
        &self,
        Parameters(params): Parameters<ReadNotificationsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::phase2cd::device_read_notifications(self, params).await
    }

    #[tool(
        name = "device_dismiss_notification",
        description = "Dismiss a notification by its key (obtained from device_read_notifications). Useful for clearing alerts after reading them."
    )]
    async fn device_dismiss_notification(
        &self,
        Parameters(params): Parameters<DismissNotificationParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::phase2cd::device_dismiss_notification(self, params).await
    }

    // ===== Intelligence tools =====

    #[tool(
        name = "device_history",
        description = "View recent action history from this session. Returns the last N actions with timestamps, tool names, parameters, success/failure status, and duration. Useful for reviewing what has been done, debugging failed sequences, and avoiding repeating failed approaches. Default limit: 20, max: 100."
    )]
    async fn device_history(
        &self,
        Parameters(params): Parameters<DeviceHistoryParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::intelligence::device_history(self, params).await
    }

    #[tool(
        name = "device_smart_read",
        description = "Intelligently read the device screen. Reads the accessibility tree first, then automatically takes a screenshot if fewer than 5 nodes are found (indicating a WebView, Flutter app, game, or canvas-based UI). Returns both the tree and screenshot in those cases, giving you the best of both worlds. Use this instead of device_read_screen when you're unsure about the app's UI framework."
    )]
    async fn device_smart_read(
        &self,
        Parameters(params): Parameters<SmartReadParams>,
    ) -> Result<CallToolResult, ErrorData> {
        tools::intelligence::device_smart_read(self, params).await
    }
}

impl ThumperServer {
    /// Resolve the target device pubkey: use the explicit param if given,
    /// otherwise fall back to the configured default.
    fn resolve_target(&self, device: Option<&str>) -> String {
        device
            .map(|d| d.to_string())
            .unwrap_or_else(|| self.config.device_pubkey.clone())
    }

    async fn send_and_wait(&self, envelope: Envelope) -> Result<Envelope, ErrorData> {
        let conn = self.connection.lock().await;
        let conn = conn
            .as_ref()
            .ok_or_else(|| ErrorData::internal_error("not connected to relay", None))?;

        let timeout = Duration::from_secs(self.config.timeout_secs);
        conn.send_command(envelope, timeout)
            .await
            .map_err(|e| ErrorData::internal_error(format!("relay error: {}", e), None))
    }

    /// Send a command with automatic retry on transient errors.
    /// Retries on "no_active_window" device errors and connection errors.
    /// Uses 500ms * attempt backoff between retries.
    async fn send_and_wait_with_retry<F>(
        &self,
        make_envelope: F,
        max_retries: u32,
    ) -> Result<Envelope, ErrorData>
    where
        F: Fn() -> Envelope,
    {
        let mut attempt = 0u32;
        loop {
            let envelope = make_envelope();
            match self.send_and_wait(envelope).await {
                Ok(response) => {
                    // Check if the device returned a retryable error
                    if let MessageType::Error(ref e) = response.message {
                        if attempt < max_retries && is_retryable_error(&e.code) {
                            attempt += 1;
                            let delay = Duration::from_millis(500 * attempt as u64);
                            tracing::debug!(
                                attempt = attempt,
                                error_code = %e.code,
                                delay_ms = delay.as_millis(),
                                "retrying after retryable device error"
                            );
                            tokio::time::sleep(delay).await;
                            continue;
                        }
                    }
                    return Ok(response);
                }
                Err(e) => {
                    if attempt < max_retries && is_retryable_relay_error(&e) {
                        attempt += 1;
                        let delay = Duration::from_millis(500 * attempt as u64);
                        tracing::debug!(
                            attempt = attempt,
                            error = %e.message,
                            delay_ms = delay.as_millis(),
                            "retrying after relay error"
                        );
                        tokio::time::sleep(delay).await;
                        continue;
                    }
                    return Err(e);
                }
            }
        }
    }

    fn handle_screen_response(&self, response: Envelope) -> Result<CallToolResult, ErrorData> {
        match response.message {
            MessageType::ScreenState(state) => Ok(CallToolResult::success(vec![Content::text(
                serde_json::to_string_pretty(&state).unwrap_or_default(),
            )])),
            MessageType::Error(e) => Err(ErrorData::internal_error(
                format!("device error: {} - {}", e.code, e.message),
                None,
            )),
            _ => Err(ErrorData::internal_error("unexpected response type", None)),
        }
    }

    fn handle_action_response(&self, response: Envelope) -> Result<CallToolResult, ErrorData> {
        match response.message {
            MessageType::ActionResult(ref result) => {
                let mut text =
                    serde_json::to_string_pretty(&result).unwrap_or_default();
                if result.screen_after.is_none() {
                    text.push_str(
                        "\n(screen_after omitted — use device_read_screen or device_wait_for to check the result)",
                    );
                }
                Ok(CallToolResult::success(vec![Content::text(text)]))
            }
            MessageType::Error(e) => Err(ErrorData::internal_error(
                format!("device error: {} - {}", e.code, e.message),
                None,
            )),
            _ => Err(ErrorData::internal_error("unexpected response type", None)),
        }
    }
}

/// Check if a device error code is retryable.
fn is_retryable_error(code: &str) -> bool {
    code == "no_active_window" || code == "transient_error"
}

/// Check if a relay-level ErrorData is retryable (connection issues).
fn is_retryable_relay_error(e: &ErrorData) -> bool {
    let msg = e.message.to_lowercase();
    msg.contains("not connected") || msg.contains("connection") || msg.contains("channel closed")
}

#[tool_handler]
impl ServerHandler for ThumperServer {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::default();
        info.instructions = Some(
            "Thumper device agent -- remotely control an Android phone via accessibility APIs.\n\n\
             RECOMMENDED WORKFLOW:\n\
             1. device_status -- verify device is connected\n\
             2. device_read_screen -- see what's on screen (always do this first)\n\
             3. Interact using device_tap, device_type_text, device_swipe, device_scroll, etc.\n\
             4. device_wait_for -- wait for UI to settle after loading actions\n\
             5. device_read_screen -- verify the result\n\n\
             BEST PRACTICES:\n\
             - Actions (tap, type, swipe, etc.) return instantly by default (~50ms). Pass wait=true to wait for screen stabilization.\n\
             - For multi-step sequences: fire actions fast, then call device_read_screen or device_wait_for when you need to check the result.\n\
             - Prefer text selectors over coordinates (more reliable across devices)\n\
             - Use device_wait_for after tapping buttons that trigger navigation or loading\n\
             - Use device_smart_read for apps with few accessibility nodes (WebViews, Flutter, games)\n\
             - Use device_screenshot when you need visual context (icons, images, charts)\n\
             - Use device_execute_flow for scripted multi-step operations (zero AI cost per step)\n\
             - Use device_history to review recent actions and avoid repeating failed approaches\n\n\
             ERROR RECOVERY:\n\
             - 'no matching node' -> call device_read_screen to see current state, try different selector\n\
             - App crash -> use device_launch_app to restart\n\
             - Stuck screen -> try device_press_back or device_global_action(home)\n\
             - Connection lost -> tools will auto-reconnect, retry after a few seconds\n\n\
             All tools accept an optional 'device' parameter for multi-device targeting.\n\
             Every action automatically returns the updated screen state."
                .into(),
        );
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info
    }
}

/// Run the MCP server over stdio.
pub async fn run() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();

    let config = ThumperConfig::load()?;

    // Try to connect to the relay
    let connection = match RelayConnection::connect(&config).await {
        Ok(conn) => {
            tracing::info!("connected to relay at {}", config.relay_url);
            Some(conn)
        }
        Err(e) => {
            tracing::warn!(
                "failed to connect to relay: {} (tools will return errors until connected)",
                e
            );
            None
        }
    };

    let server = ThumperServer::new(config, connection);
    let service = server.serve(stdio()).await?;
    service.waiting().await?;

    Ok(())
}

mod config;
mod connection;
mod flows;

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

use thumper_types::*;

use crate::config::ThumperConfig;
use crate::connection::RelayConnection;
use crate::flows::FlowRegistry;

pub struct ThumperServer {
    connection: Arc<Mutex<Option<RelayConnection>>>,
    config: ThumperConfig,
    flow_registry: FlowRegistry,
    tool_router: ToolRouter<Self>,
}

// -- Tool parameter types --

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DeviceStatusParams {}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReadScreenParams {
    /// Target device pubkey (optional — defaults to configured device).
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
    /// Target device pubkey (optional — defaults to configured device).
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
    /// Target device pubkey (optional — defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct LaunchAppParams {
    /// Android package name (e.g., "app.phantom").
    pub package: String,
    /// Target device pubkey (optional — defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct PressBackParams {
    /// Target device pubkey (optional — defaults to configured device).
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
    /// Target device pubkey (optional — defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ScreenshotToolParams {
    /// Scale factor (0.25-1.0). Lower = smaller file, faster transfer. Default 0.5.
    pub scale: Option<f64>,
    /// JPEG quality (1-100). Default 50.
    pub quality: Option<u32>,
    /// Target device pubkey (optional — defaults to configured device).
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
    /// Target device pubkey (optional — defaults to configured device).
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
    /// Target device pubkey (optional — defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GlobalActionParams {
    /// Action to perform: "home", "recents", "notifications", "quick_settings", "power_dialog".
    pub action: String,
    /// Target device pubkey (optional — defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ClipboardSetParams {
    /// Text to copy to the clipboard.
    pub text: String,
    /// Target device pubkey (optional — defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ClipboardGetParams {
    /// Target device pubkey (optional — defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DeviceInfoParams {
    /// Target device pubkey (optional — defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ListAppsParams {
    /// Target device pubkey (optional — defaults to configured device).
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
    /// Target device pubkey (optional — defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ExecuteFlowParams {
    /// Name of the flow to execute (from device_list_flows).
    pub flow_name: String,
    /// Parameter values for the flow (key-value pairs).
    pub params: Option<std::collections::HashMap<String, String>>,
    /// Target device pubkey (optional — defaults to configured device).
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
    /// Target device pubkey (optional — defaults to configured device).
    pub device: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DismissNotificationParams {
    /// Notification key to dismiss (from device_read_notifications).
    pub key: String,
    /// Target device pubkey (optional — defaults to configured device).
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
            tool_router: Self::tool_router(),
        }
    }

    // ===== Phase 1 tools =====

    #[tool(
        name = "device_status",
        description = "Check whether the device is connected and reachable via the relay"
    )]
    async fn device_status(
        &self,
        Parameters(_params): Parameters<DeviceStatusParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let conn = self.connection.lock().await;
        let connected = conn.as_ref().map_or(false, |c| c.is_connected());

        Ok(CallToolResult::success(vec![Content::text(
            serde_json::json!({
                "connected": connected,
                "relay_url": self.config.relay_url,
                "device_pubkey": self.config.device_pubkey,
            })
            .to_string(),
        )]))
    }

    #[tool(
        name = "device_read_screen",
        description = "Read the device screen and return the UI accessibility tree as structured JSON. Returns all visible UI elements with their text, descriptions, bounds, and interactive properties. Call this first to understand what's on screen before taking any action."
    )]
    async fn device_read_screen(
        &self,
        Parameters(params): Parameters<ReadScreenParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let target = self.resolve_target(params.device.as_deref());
        let envelope = Envelope::new(MessageType::ReadScreen).with_target(target);

        let response = self.send_and_wait(envelope).await?;
        self.handle_screen_response(response)
    }

    #[tool(
        name = "device_tap",
        description = "Tap a UI element on the device screen. Specify the element by text, description, resource ID, or screen coordinates. Automatically returns the updated screen state after the tap so you can see what changed."
    )]
    async fn device_tap(
        &self,
        Parameters(params): Parameters<TapParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let target = self.resolve_target(params.device.as_deref());
        let selector = NodeSelector {
            text: params.text,
            text_contains: params.text_contains,
            desc: params.desc,
            desc_contains: params.desc_contains,
            resource_id: params.resource_id,
            class: None,
            clickable: Some(true),
            coordinates: params.coordinates,
        };

        let envelope = Envelope::new(MessageType::Tap(selector)).with_target(target);

        let response = self.send_and_wait(envelope).await?;
        self.handle_action_response(response)
    }

    #[tool(
        name = "device_type_text",
        description = "Type text into an input field on the device screen. Specify the target field by its text, description, or resource ID. Automatically returns the updated screen state after typing."
    )]
    async fn device_type_text(
        &self,
        Parameters(params): Parameters<TypeTextParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let target = self.resolve_target(params.device.as_deref());
        let selector = NodeSelector {
            text: params.field_text,
            text_contains: None,
            desc: params.field_desc,
            desc_contains: params.field_desc_contains,
            resource_id: params.field_resource_id,
            class: None,
            clickable: None,
            coordinates: None,
        };

        let payload = TypeTextPayload {
            selector,
            text: params.text,
        };

        let envelope = Envelope::new(MessageType::TypeText(payload)).with_target(target);

        let response = self.send_and_wait(envelope).await?;
        self.handle_action_response(response)
    }

    #[tool(
        name = "device_launch_app",
        description = "Launch an Android app on the device by its package name (e.g., 'app.phantom' for Phantom wallet, 'com.google.android.apps.maps' for Maps). Automatically returns the screen state after the app launches."
    )]
    async fn device_launch_app(
        &self,
        Parameters(params): Parameters<LaunchAppParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let target = self.resolve_target(params.device.as_deref());
        let payload = LaunchAppPayload {
            package: params.package,
        };

        let envelope = Envelope::new(MessageType::LaunchApp(payload)).with_target(target);

        let response = self.send_and_wait(envelope).await?;
        self.handle_action_response(response)
    }

    #[tool(
        name = "device_press_back",
        description = "Press the Android back button. Useful for closing dialogs, going back in navigation, or dismissing keyboards. Automatically returns the updated screen state."
    )]
    async fn device_press_back(
        &self,
        Parameters(params): Parameters<PressBackParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let target = self.resolve_target(params.device.as_deref());
        let envelope = Envelope::new(MessageType::PressBack).with_target(target);

        let response = self.send_and_wait(envelope).await?;
        self.handle_action_response(response)
    }

    #[tool(
        name = "device_swipe",
        description = "Swipe on the device screen in a direction (up/down/left/right). Use 'up' to scroll down through content, 'down' to scroll up. Useful for scrolling lists, navigating between pages, or pulling to refresh. Automatically returns the updated screen state."
    )]
    async fn device_swipe(
        &self,
        Parameters(params): Parameters<SwipeParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let target = self.resolve_target(params.device.as_deref());
        let distance = params.distance.unwrap_or(0.5).clamp(0.1, 0.9);
        let duration_ms = params.duration_ms.unwrap_or(300);

        let (cx, cy) = (540, 1200);
        let dx = (540.0 * distance) as i32;
        let dy = (1200.0 * distance) as i32;

        let (from, to) = match params.direction.to_lowercase().as_str() {
            "up" => ([cx, cy + dy / 2], [cx, cy - dy / 2]),
            "down" => ([cx, cy - dy / 2], [cx, cy + dy / 2]),
            "left" => ([cx + dx / 2, cy], [cx - dx / 2, cy]),
            "right" => ([cx - dx / 2, cy], [cx + dx / 2, cy]),
            other => {
                return Err(ErrorData::internal_error(
                    format!(
                        "invalid direction '{}': use 'up', 'down', 'left', or 'right'",
                        other
                    ),
                    None,
                ));
            }
        };

        let payload = SwipePayload {
            from,
            to,
            duration_ms,
        };

        let envelope = Envelope::new(MessageType::Swipe(payload)).with_target(target);

        let response = self.send_and_wait(envelope).await?;
        self.handle_action_response(response)
    }

    // ===== Phase 2A tools =====

    #[tool(
        name = "device_screenshot",
        description = "Take a screenshot of the device screen and return it as a JPEG image. Use this when the accessibility tree doesn't provide enough visual context (icons, images, graphs, layouts). More expensive than read_screen but gives full visual information."
    )]
    async fn device_screenshot(
        &self,
        Parameters(params): Parameters<ScreenshotToolParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let target = self.resolve_target(params.device.as_deref());
        let screenshot_params = ScreenshotParams {
            scale: params.scale.unwrap_or(0.5).clamp(0.25, 1.0),
            quality: params.quality.unwrap_or(50).clamp(1, 100),
        };

        let envelope =
            Envelope::new(MessageType::TakeScreenshot(screenshot_params)).with_target(target);

        let response = self.send_and_wait(envelope).await?;

        match response.message {
            MessageType::ScreenshotResult(result) => {
                Ok(CallToolResult::success(vec![Content::image(
                    result.image_base64,
                    &result.mime_type,
                )]))
            }
            MessageType::Error(e) => Err(ErrorData::internal_error(
                format!("device error: {} - {}", e.code, e.message),
                None,
            )),
            _ => Err(ErrorData::internal_error("unexpected response type", None)),
        }
    }

    #[tool(
        name = "device_long_press",
        description = "Long press a UI element to trigger context menus or drag operations. Specify the element by text, description, resource ID, or coordinates. Default hold duration is 500ms. Automatically returns the updated screen state."
    )]
    async fn device_long_press(
        &self,
        Parameters(params): Parameters<LongPressParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let target = self.resolve_target(params.device.as_deref());
        let selector = NodeSelector {
            text: params.text,
            text_contains: params.text_contains,
            desc: params.desc,
            desc_contains: params.desc_contains,
            resource_id: params.resource_id,
            class: None,
            clickable: None,
            coordinates: params.coordinates,
        };

        let payload = LongPressPayload {
            selector,
            duration_ms: params.duration_ms.unwrap_or(500),
        };

        let envelope = Envelope::new(MessageType::LongPress(payload)).with_target(target);

        let response = self.send_and_wait(envelope).await?;
        self.handle_action_response(response)
    }

    #[tool(
        name = "device_scroll",
        description = "Scroll a scrollable view up, down, left, or right using accessibility actions. More reliable than swipe for scrolling lists and containers. Optionally target a specific scrollable container by text or resource ID. Automatically returns the updated screen state."
    )]
    async fn device_scroll(
        &self,
        Parameters(params): Parameters<ScrollParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let target = self.resolve_target(params.device.as_deref());
        let direction = match params.direction.to_lowercase().as_str() {
            "up" => ScrollDirection::Up,
            "down" => ScrollDirection::Down,
            "left" => ScrollDirection::Left,
            "right" => ScrollDirection::Right,
            other => {
                return Err(ErrorData::internal_error(
                    format!(
                        "invalid direction '{}': use 'up', 'down', 'left', or 'right'",
                        other
                    ),
                    None,
                ));
            }
        };

        let selector = if params.container_text.is_some() || params.container_resource_id.is_some()
        {
            Some(NodeSelector {
                text: params.container_text,
                text_contains: None,
                desc: None,
                desc_contains: None,
                resource_id: params.container_resource_id,
                class: None,
                clickable: None,
                coordinates: None,
            })
        } else {
            None
        };

        let payload = ScrollPayload {
            selector,
            direction,
        };

        let envelope = Envelope::new(MessageType::Scroll(payload)).with_target(target);

        let response = self.send_and_wait(envelope).await?;
        self.handle_action_response(response)
    }

    #[tool(
        name = "device_global_action",
        description = "Perform a global device action: 'home' (go to home screen), 'recents' (open recent apps), 'notifications' (pull down notification shade), 'quick_settings' (open quick settings), or 'power_dialog' (show power menu). Automatically returns the updated screen state."
    )]
    async fn device_global_action(
        &self,
        Parameters(params): Parameters<GlobalActionParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let target = self.resolve_target(params.device.as_deref());
        let action = match params.action.to_lowercase().as_str() {
            "home" => GlobalAction::Home,
            "recents" => GlobalAction::Recents,
            "notifications" => GlobalAction::Notifications,
            "quick_settings" => GlobalAction::QuickSettings,
            "power_dialog" => GlobalAction::PowerDialog,
            other => {
                return Err(ErrorData::internal_error(
                    format!(
                        "invalid action '{}': use 'home', 'recents', 'notifications', 'quick_settings', or 'power_dialog'",
                        other
                    ),
                    None,
                ));
            }
        };

        let payload = GlobalActionPayload { action };

        let envelope = Envelope::new(MessageType::GlobalAction(payload)).with_target(target);

        let response = self.send_and_wait(envelope).await?;
        self.handle_action_response(response)
    }

    #[tool(
        name = "device_clipboard_set",
        description = "Copy text to the device clipboard. Useful for pasting addresses, amounts, or other data into apps."
    )]
    async fn device_clipboard_set(
        &self,
        Parameters(params): Parameters<ClipboardSetParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let target = self.resolve_target(params.device.as_deref());
        let payload = ClipboardSetPayload { text: params.text };

        let envelope = Envelope::new(MessageType::SetClipboard(payload)).with_target(target);

        let response = self.send_and_wait(envelope).await?;
        self.handle_action_response(response)
    }

    #[tool(
        name = "device_clipboard_get",
        description = "Read the current text from the device clipboard."
    )]
    async fn device_clipboard_get(
        &self,
        Parameters(params): Parameters<ClipboardGetParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let target = self.resolve_target(params.device.as_deref());
        let envelope = Envelope::new(MessageType::GetClipboard).with_target(target);

        let response = self.send_and_wait(envelope).await?;

        match response.message {
            MessageType::ClipboardResult(result) => {
                Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&result).unwrap_or_default(),
                )]))
            }
            MessageType::Error(e) => Err(ErrorData::internal_error(
                format!("device error: {} - {}", e.code, e.message),
                None,
            )),
            _ => Err(ErrorData::internal_error("unexpected response type", None)),
        }
    }

    #[tool(
        name = "device_info",
        description = "Get device information including battery level, screen dimensions, Android version, connectivity status, and hardware details. Useful for understanding the device context before performing actions."
    )]
    async fn device_info(
        &self,
        Parameters(params): Parameters<DeviceInfoParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let target = self.resolve_target(params.device.as_deref());
        let envelope = Envelope::new(MessageType::GetDeviceInfo).with_target(target);

        let response = self.send_and_wait(envelope).await?;

        match response.message {
            MessageType::DeviceInfoResult(info) => {
                Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&info).unwrap_or_default(),
                )]))
            }
            MessageType::Error(e) => Err(ErrorData::internal_error(
                format!("device error: {} - {}", e.code, e.message),
                None,
            )),
            _ => Err(ErrorData::internal_error("unexpected response type", None)),
        }
    }

    #[tool(
        name = "device_list_apps",
        description = "List all installed apps on the device with their package names and display labels. Useful for finding the correct package name to use with device_launch_app."
    )]
    async fn device_list_apps(
        &self,
        Parameters(params): Parameters<ListAppsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let target = self.resolve_target(params.device.as_deref());
        let envelope = Envelope::new(MessageType::ListInstalledApps).with_target(target);

        let response = self.send_and_wait(envelope).await?;

        match response.message {
            MessageType::InstalledAppsResult(result) => {
                Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&result).unwrap_or_default(),
                )]))
            }
            MessageType::Error(e) => Err(ErrorData::internal_error(
                format!("device error: {} - {}", e.code, e.message),
                None,
            )),
            _ => Err(ErrorData::internal_error("unexpected response type", None)),
        }
    }

    #[tool(
        name = "device_wait_for",
        description = "Wait for a UI element matching the selector to appear on screen. Polls the accessibility tree at regular intervals until the element is found or timeout is reached. Returns the final screen state and whether the element was found. Use this after actions that trigger loading or transitions (e.g., after tapping 'Send', wait for 'Confirmed')."
    )]
    async fn device_wait_for(
        &self,
        Parameters(params): Parameters<WaitForParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let target = self.resolve_target(params.device.as_deref());
        let selector = NodeSelector {
            text: params.text,
            text_contains: params.text_contains,
            desc: params.desc,
            desc_contains: params.desc_contains,
            resource_id: params.resource_id,
            class: None,
            clickable: None,
            coordinates: None,
        };

        let payload = WaitForPayload {
            selector,
            timeout_ms: params.timeout_ms.unwrap_or(10000),
            poll_interval_ms: params.poll_interval_ms.unwrap_or(500),
        };

        let envelope = Envelope::new(MessageType::WaitFor(payload)).with_target(target);

        // Use a longer timeout for wait_for since the device-side timeout can be up to 30s
        let timeout = Duration::from_millis(
            self.config.timeout_secs * 1000 + params.timeout_ms.unwrap_or(10000) + 2000,
        );

        let conn = self.connection.lock().await;
        let conn = conn
            .as_ref()
            .ok_or_else(|| ErrorData::internal_error("not connected to relay", None))?;

        let response = conn
            .send_command(envelope, timeout)
            .await
            .map_err(|e| ErrorData::internal_error(format!("relay error: {}", e), None))?;

        match response.message {
            MessageType::WaitForResult(result) => {
                Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&result).unwrap_or_default(),
                )]))
            }
            MessageType::Error(e) => Err(ErrorData::internal_error(
                format!("device error: {} - {}", e.code, e.message),
                None,
            )),
            _ => Err(ErrorData::internal_error("unexpected response type", None)),
        }
    }

    // ===== Phase 2B tools =====

    #[tool(
        name = "device_execute_flow",
        description = "Execute a pre-defined multi-step flow on the device. Flows are scripted sequences of actions (tap, type, wait, etc.) that run entirely on-device with zero AI cost per step. Use device_list_flows to see available flows and their required parameters. Example: device_execute_flow(flow_name='send_token', params={recipient: 'alice.sol', amount: '1'})"
    )]
    async fn device_execute_flow(
        &self,
        Parameters(params): Parameters<ExecuteFlowParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let target = self.resolve_target(params.device.as_deref());
        let flow = self
            .flow_registry
            .get(&params.flow_name)
            .ok_or_else(|| {
                ErrorData::internal_error(
                    format!(
                        "flow '{}' not found. Use device_list_flows to see available flows.",
                        params.flow_name
                    ),
                    None,
                )
            })?
            .clone();

        // Validate required params
        let param_values = params.params.unwrap_or_default();
        for p in &flow.params {
            if p.required && !param_values.contains_key(&p.name) && p.default.is_none() {
                return Err(ErrorData::internal_error(
                    format!("missing required parameter: '{}'", p.name),
                    None,
                ));
            }
        }

        let payload = FlowExecutePayload {
            flow,
            params: param_values,
        };

        let envelope = Envelope::new(MessageType::ExecuteFlow(payload)).with_target(target);

        // Flow execution can take a while — use generous timeout
        let timeout = Duration::from_secs(120);

        let conn = self.connection.lock().await;
        let conn = conn
            .as_ref()
            .ok_or_else(|| ErrorData::internal_error("not connected to relay", None))?;

        let response = conn
            .send_command(envelope, timeout)
            .await
            .map_err(|e| ErrorData::internal_error(format!("relay error: {}", e), None))?;

        match response.message {
            MessageType::FlowResult(result) => {
                Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&result).unwrap_or_default(),
                )]))
            }
            MessageType::Error(e) => Err(ErrorData::internal_error(
                format!("device error: {} - {}", e.code, e.message),
                None,
            )),
            _ => Err(ErrorData::internal_error("unexpected response type", None)),
        }
    }

    #[tool(
        name = "device_list_flows",
        description = "List all available flow definitions with their names, descriptions, and required parameters. Flows are pre-scripted multi-step operations that execute on-device with zero AI cost per step."
    )]
    async fn device_list_flows(
        &self,
        Parameters(_params): Parameters<ListFlowsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let flows = self.flow_registry.list();
        Ok(CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&flows).unwrap_or_default(),
        )]))
    }

    // ===== Phase 2C tools =====

    #[tool(
        name = "device_list_devices",
        description = "List all devices currently connected to the relay. Returns each device's pubkey and label (if available). Use the pubkey as the 'device' parameter on other tools to target a specific device."
    )]
    async fn device_list_devices(
        &self,
        Parameters(_params): Parameters<ListDevicesParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let envelope = Envelope::new(MessageType::ListConnectedDevices);

        let response = self.send_and_wait(envelope).await?;

        match response.message {
            MessageType::ConnectedDevicesResult(result) => {
                Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&result).unwrap_or_default(),
                )]))
            }
            MessageType::Error(e) => Err(ErrorData::internal_error(
                format!("relay error: {} - {}", e.code, e.message),
                None,
            )),
            _ => Err(ErrorData::internal_error("unexpected response type", None)),
        }
    }

    // ===== Phase 2D tools (Notifications) =====

    #[tool(
        name = "device_read_notifications",
        description = "Read recent notifications from the device. Returns app package, title, text, and timestamp for each notification. Useful for checking if a transaction confirmation arrived, reading messages, or monitoring alerts."
    )]
    async fn device_read_notifications(
        &self,
        Parameters(params): Parameters<ReadNotificationsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let target = self.resolve_target(params.device.as_deref());
        let payload = ReadNotificationsPayload {
            limit: params.limit.unwrap_or(20),
        };

        let envelope =
            Envelope::new(MessageType::ReadNotifications(payload)).with_target(target);

        let response = self.send_and_wait(envelope).await?;

        match response.message {
            MessageType::NotificationsResult(result) => {
                Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&result).unwrap_or_default(),
                )]))
            }
            MessageType::Error(e) => Err(ErrorData::internal_error(
                format!("device error: {} - {}", e.code, e.message),
                None,
            )),
            _ => Err(ErrorData::internal_error("unexpected response type", None)),
        }
    }

    #[tool(
        name = "device_dismiss_notification",
        description = "Dismiss a notification by its key (obtained from device_read_notifications). Useful for clearing alerts after reading them."
    )]
    async fn device_dismiss_notification(
        &self,
        Parameters(params): Parameters<DismissNotificationParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let target = self.resolve_target(params.device.as_deref());
        let payload = DismissNotificationPayload { key: params.key };

        let envelope =
            Envelope::new(MessageType::DismissNotification(payload)).with_target(target);

        let response = self.send_and_wait(envelope).await?;
        self.handle_action_response(response)
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
            MessageType::ActionResult(result) => {
                Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&result).unwrap_or_default(),
                )]))
            }
            MessageType::Error(e) => Err(ErrorData::internal_error(
                format!("device error: {} - {}", e.code, e.message),
                None,
            )),
            _ => Err(ErrorData::internal_error("unexpected response type", None)),
        }
    }
}

#[tool_handler]
impl ServerHandler for ThumperServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            instructions: Some(
                "Thumper device agent — remotely control an Android phone. \
                 Always call device_read_screen first to see what's on screen. \
                 Use device_screenshot when you need visual context (icons, images, layouts). \
                 Use device_tap, device_long_press, device_type_text, device_swipe, \
                 device_scroll, device_press_back, or device_launch_app to interact. \
                 Use device_global_action for home/recents/notifications. \
                 Use device_wait_for to wait for UI changes after actions. \
                 Use device_execute_flow for scripted multi-step operations (zero AI cost). \
                 Use device_read_notifications to check incoming notifications. \
                 Use device_list_devices to see all connected devices. \
                 All tools accept an optional 'device' parameter for multi-device targeting. \
                 Every action automatically returns the updated screen state."
                    .into(),
            ),
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            ..Default::default()
        }
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

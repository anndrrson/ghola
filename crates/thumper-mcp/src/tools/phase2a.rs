use std::time::Duration;

use rmcp::{model::*, ErrorData};
use thumper_types::*;

use crate::memory::{now_millis, ActionRecord};
use crate::{
    ClipboardGetParams, ClipboardSetParams, DeviceInfoParams, GlobalActionParams, ListAppsParams,
    LongPressParams, ScrollParams, ScreenshotToolParams, ThumperServer, WaitForParams,
};

pub(crate) async fn device_screenshot(
    server: &ThumperServer,
    params: ScreenshotToolParams,
) -> Result<CallToolResult, ErrorData> {
    let target = server.resolve_target(params.device.as_deref());
    let screenshot_params = ScreenshotParams {
        scale: params.scale.unwrap_or(0.75).clamp(0.25, 1.0),
        quality: params.quality.unwrap_or(70).clamp(1, 100),
    };

    let envelope =
        Envelope::new(MessageType::TakeScreenshot(screenshot_params)).with_target(target);
    let response = server.send_and_wait(envelope).await?;

    match response.message {
        MessageType::ScreenshotResult(result) => Ok(CallToolResult::success(vec![
            Content::image(result.image_base64, &result.mime_type),
        ])),
        MessageType::Error(e) => Err(ErrorData::internal_error(
            format!("device error: {} - {}", e.code, e.message),
            None,
        )),
        _ => Err(ErrorData::internal_error("unexpected response type", None)),
    }
}

pub(crate) async fn device_long_press(
    server: &ThumperServer,
    params: LongPressParams,
) -> Result<CallToolResult, ErrorData> {
    let target = server.resolve_target(params.device.as_deref());
    let skip_wait = !params.wait.unwrap_or(false);
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

    let start = now_millis();
    let envelope = Envelope::new(MessageType::LongPress(payload))
        .with_target(target)
        .with_skip_wait(skip_wait);
    let response = server.send_and_wait(envelope).await?;
    let duration_ms = now_millis() - start;

    let success = matches!(&response.message, MessageType::ActionResult(r) if r.success);
    let mut mem = server.memory.lock().await;
    let current_app = mem.current_app.clone();
    mem.record_action(ActionRecord {
        timestamp: now_millis(),
        tool_name: "device_long_press".to_string(),
        params_summary: String::new(),
        success,
        app_package: current_app,
        duration_ms,
    });
    drop(mem);

    server.handle_action_response(response)
}

pub(crate) async fn device_scroll(
    server: &ThumperServer,
    params: ScrollParams,
) -> Result<CallToolResult, ErrorData> {
    let target = server.resolve_target(params.device.as_deref());
    let skip_wait = !params.wait.unwrap_or(false);
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

    let selector = if params.container_text.is_some() || params.container_resource_id.is_some() {
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

    let start = now_millis();
    let envelope = Envelope::new(MessageType::Scroll(payload))
        .with_target(target)
        .with_skip_wait(skip_wait);
    let response = server.send_and_wait(envelope).await?;
    let duration_ms = now_millis() - start;

    let success = matches!(&response.message, MessageType::ActionResult(r) if r.success);
    let mut mem = server.memory.lock().await;
    let current_app = mem.current_app.clone();
    mem.record_action(ActionRecord {
        timestamp: now_millis(),
        tool_name: "device_scroll".to_string(),
        params_summary: format!("direction='{}'", params.direction),
        success,
        app_package: current_app,
        duration_ms,
    });
    drop(mem);

    server.handle_action_response(response)
}

pub(crate) async fn device_global_action(
    server: &ThumperServer,
    params: GlobalActionParams,
) -> Result<CallToolResult, ErrorData> {
    let target = server.resolve_target(params.device.as_deref());
    let skip_wait = !params.wait.unwrap_or(false);
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

    let summary = format!("action='{}'", params.action);
    let payload = GlobalActionPayload { action };

    let start = now_millis();
    let envelope = Envelope::new(MessageType::GlobalAction(payload))
        .with_target(target)
        .with_skip_wait(skip_wait);
    let response = server.send_and_wait(envelope).await?;
    let duration_ms = now_millis() - start;

    let success = matches!(&response.message, MessageType::ActionResult(r) if r.success);
    let mut mem = server.memory.lock().await;
    let current_app = mem.current_app.clone();
    mem.record_action(ActionRecord {
        timestamp: now_millis(),
        tool_name: "device_global_action".to_string(),
        params_summary: summary,
        success,
        app_package: current_app,
        duration_ms,
    });
    drop(mem);

    server.handle_action_response(response)
}

pub(crate) async fn device_clipboard_set(
    server: &ThumperServer,
    params: ClipboardSetParams,
) -> Result<CallToolResult, ErrorData> {
    let target = server.resolve_target(params.device.as_deref());
    let payload = ClipboardSetPayload { text: params.text };

    let envelope = Envelope::new(MessageType::SetClipboard(payload)).with_target(target);
    let response = server.send_and_wait(envelope).await?;
    server.handle_action_response(response)
}

pub(crate) async fn device_clipboard_get(
    server: &ThumperServer,
    params: ClipboardGetParams,
) -> Result<CallToolResult, ErrorData> {
    let target = server.resolve_target(params.device.as_deref());
    let envelope = Envelope::new(MessageType::GetClipboard).with_target(target);
    let response = server.send_and_wait(envelope).await?;

    match response.message {
        MessageType::ClipboardResult(result) => Ok(CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&result).unwrap_or_default(),
        )])),
        MessageType::Error(e) => Err(ErrorData::internal_error(
            format!("device error: {} - {}", e.code, e.message),
            None,
        )),
        _ => Err(ErrorData::internal_error("unexpected response type", None)),
    }
}

pub(crate) async fn device_info(
    server: &ThumperServer,
    params: DeviceInfoParams,
) -> Result<CallToolResult, ErrorData> {
    let target = server.resolve_target(params.device.as_deref());
    let envelope = Envelope::new(MessageType::GetDeviceInfo).with_target(target);
    let response = server.send_and_wait(envelope).await?;

    match response.message {
        MessageType::DeviceInfoResult(info) => {
            // Cache device profile for swipe calculations
            {
                let mut profile = server.device_profile.lock().await;
                *profile = Some(info.clone());
            }
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

pub(crate) async fn device_list_apps(
    server: &ThumperServer,
    params: ListAppsParams,
) -> Result<CallToolResult, ErrorData> {
    let target = server.resolve_target(params.device.as_deref());
    let envelope = Envelope::new(MessageType::ListInstalledApps).with_target(target);
    let response = server.send_and_wait(envelope).await?;

    match response.message {
        MessageType::InstalledAppsResult(result) => Ok(CallToolResult::success(vec![
            Content::text(serde_json::to_string_pretty(&result).unwrap_or_default()),
        ])),
        MessageType::Error(e) => Err(ErrorData::internal_error(
            format!("device error: {} - {}", e.code, e.message),
            None,
        )),
        _ => Err(ErrorData::internal_error("unexpected response type", None)),
    }
}

pub(crate) async fn device_wait_for(
    server: &ThumperServer,
    params: WaitForParams,
) -> Result<CallToolResult, ErrorData> {
    let target = server.resolve_target(params.device.as_deref());
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

    let timeout_ms_val = params.timeout_ms.unwrap_or(10000);
    let payload = WaitForPayload {
        selector,
        timeout_ms: timeout_ms_val,
        poll_interval_ms: params.poll_interval_ms.unwrap_or(500),
    };

    let envelope = Envelope::new(MessageType::WaitFor(payload)).with_target(target);

    // Use a longer timeout for wait_for since the device-side timeout can be long
    let timeout = Duration::from_millis(server.config.timeout_secs * 1000 + timeout_ms_val + 2000);

    let conn = server.connection.lock().await;
    let conn = conn
        .as_ref()
        .ok_or_else(|| ErrorData::internal_error("not connected to relay", None))?;

    let response = conn
        .send_command(envelope, timeout)
        .await
        .map_err(|e| ErrorData::internal_error(format!("relay error: {}", e), None))?;

    match response.message {
        MessageType::WaitForResult(result) => Ok(CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&result).unwrap_or_default(),
        )])),
        MessageType::Error(e) => Err(ErrorData::internal_error(
            format!("device error: {} - {}", e.code, e.message),
            None,
        )),
        _ => Err(ErrorData::internal_error("unexpected response type", None)),
    }
}

use rmcp::{model::*, ErrorData};
use ghola_assistant_types::*;

use crate::memory::{now_millis, ActionRecord, ScreenSnapshot};
use crate::{
    DeviceStatusParams, LaunchAppParams, PressBackParams, ReadScreenParams, SwipeParams, TapParams,
    ThumperServer, TypeTextParams,
};

pub(crate) async fn device_status(
    server: &ThumperServer,
    _params: DeviceStatusParams,
) -> Result<CallToolResult, ErrorData> {
    let conn = server.connection.lock().await;
    let connected = conn.as_ref().map_or(false, |c| c.is_connected());
    let reconnecting = conn.as_ref().map_or(false, |c| c.is_reconnecting());

    Ok(CallToolResult::success(vec![Content::text(
        serde_json::json!({
            "connected": connected,
            "reconnecting": reconnecting,
            "relay_url": server.config.relay_url,
            "device_pubkey": server.config.device_pubkey,
        })
        .to_string(),
    )]))
}

pub(crate) async fn device_read_screen(
    server: &ThumperServer,
    params: ReadScreenParams,
) -> Result<CallToolResult, ErrorData> {
    let target = server.resolve_target(params.device.as_deref());
    let start = now_millis();

    let make_envelope = || Envelope::new(MessageType::ReadScreen).with_target(target.clone());
    let response = server.send_and_wait_with_retry(make_envelope, 2).await?;

    let duration_ms = now_millis() - start;

    // Record screen in memory
    if let MessageType::ScreenState(ref state) = response.message {
        let key_texts: Vec<String> = state
            .nodes
            .iter()
            .filter_map(|n| n.text.clone())
            .take(20)
            .collect();

        let mut mem = server.memory.lock().await;
        mem.record_screen(ScreenSnapshot {
            timestamp: now_millis(),
            package: state.package.clone(),
            activity: state.activity.clone(),
            node_count: state.nodes.len(),
            key_texts,
        });
        mem.record_action(ActionRecord {
            timestamp: now_millis(),
            tool_name: "device_read_screen".to_string(),
            params_summary: String::new(),
            success: true,
            app_package: Some(state.package.clone()),
            duration_ms,
        });
    }

    server.handle_screen_response(response)
}

pub(crate) async fn device_tap(
    server: &ThumperServer,
    params: TapParams,
) -> Result<CallToolResult, ErrorData> {
    let target = server.resolve_target(params.device.as_deref());
    let summary = tap_summary(&params);
    let skip_wait = !params.wait.unwrap_or(false);

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

    let start = now_millis();
    let make_envelope = || {
        Envelope::new(MessageType::Tap(selector.clone()))
            .with_target(target.clone())
            .with_skip_wait(skip_wait)
    };
    let response = server.send_and_wait_with_retry(make_envelope, 2).await?;
    let duration_ms = now_millis() - start;

    let success = matches!(&response.message, MessageType::ActionResult(r) if r.success);
    let mut mem = server.memory.lock().await;
    let current_app = mem.current_app.clone();
    mem.record_action(ActionRecord {
        timestamp: now_millis(),
        tool_name: "device_tap".to_string(),
        params_summary: summary,
        success,
        app_package: current_app,
        duration_ms,
    });
    drop(mem);

    server.handle_action_response(response)
}

pub(crate) async fn device_type_text(
    server: &ThumperServer,
    params: TypeTextParams,
) -> Result<CallToolResult, ErrorData> {
    let target = server.resolve_target(params.device.as_deref());
    let summary = format!("text='{}'", truncate(&params.text, 30));
    let skip_wait = !params.wait.unwrap_or(false);

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

    let text = params.text.clone();
    let start = now_millis();
    let make_envelope = || {
        let payload = TypeTextPayload {
            selector: selector.clone(),
            text: text.clone(),
        };
        Envelope::new(MessageType::TypeText(payload))
            .with_target(target.clone())
            .with_skip_wait(skip_wait)
    };
    let response = server.send_and_wait_with_retry(make_envelope, 2).await?;
    let duration_ms = now_millis() - start;

    let success = matches!(&response.message, MessageType::ActionResult(r) if r.success);
    let mut mem = server.memory.lock().await;
    let current_app = mem.current_app.clone();
    mem.record_action(ActionRecord {
        timestamp: now_millis(),
        tool_name: "device_type_text".to_string(),
        params_summary: summary,
        success,
        app_package: current_app,
        duration_ms,
    });
    drop(mem);

    server.handle_action_response(response)
}

pub(crate) async fn device_launch_app(
    server: &ThumperServer,
    params: LaunchAppParams,
) -> Result<CallToolResult, ErrorData> {
    let target = server.resolve_target(params.device.as_deref());
    let summary = format!("package='{}'", params.package);
    let skip_wait = !params.wait.unwrap_or(false);
    let payload = LaunchAppPayload {
        package: params.package,
    };

    let start = now_millis();
    let envelope = Envelope::new(MessageType::LaunchApp(payload))
        .with_target(target)
        .with_skip_wait(skip_wait);
    let response = server.send_and_wait(envelope).await?;
    let duration_ms = now_millis() - start;

    let success = matches!(&response.message, MessageType::ActionResult(r) if r.success);
    let mut mem = server.memory.lock().await;
    let current_app = mem.current_app.clone();
    mem.record_action(ActionRecord {
        timestamp: now_millis(),
        tool_name: "device_launch_app".to_string(),
        params_summary: summary,
        success,
        app_package: current_app,
        duration_ms,
    });
    drop(mem);

    server.handle_action_response(response)
}

pub(crate) async fn device_press_back(
    server: &ThumperServer,
    params: PressBackParams,
) -> Result<CallToolResult, ErrorData> {
    let target = server.resolve_target(params.device.as_deref());
    let skip_wait = !params.wait.unwrap_or(false);

    let start = now_millis();
    let envelope = Envelope::new(MessageType::PressBack)
        .with_target(target)
        .with_skip_wait(skip_wait);
    let response = server.send_and_wait(envelope).await?;
    let duration_ms = now_millis() - start;

    let success = matches!(&response.message, MessageType::ActionResult(r) if r.success);
    let mut mem = server.memory.lock().await;
    let current_app = mem.current_app.clone();
    mem.record_action(ActionRecord {
        timestamp: now_millis(),
        tool_name: "device_press_back".to_string(),
        params_summary: String::new(),
        success,
        app_package: current_app,
        duration_ms,
    });
    drop(mem);

    server.handle_action_response(response)
}

pub(crate) async fn device_swipe(
    server: &ThumperServer,
    params: SwipeParams,
) -> Result<CallToolResult, ErrorData> {
    let target = server.resolve_target(params.device.as_deref());
    let skip_wait = !params.wait.unwrap_or(false);
    let distance = params.distance.unwrap_or(0.5).clamp(0.1, 0.9);
    let duration_ms_param = params.duration_ms.unwrap_or(300);

    // Use cached device profile dimensions if available, otherwise default to 1080x2400
    let (screen_w, screen_h) = {
        let profile = server.device_profile.lock().await;
        match profile.as_ref() {
            Some(info) => (info.screen_width as i32, info.screen_height as i32),
            None => (1080, 2400),
        }
    };

    let cx = screen_w / 2;
    let cy = screen_h / 2;
    let dx = ((screen_w / 2) as f64 * distance) as i32;
    let dy = ((screen_h / 2) as f64 * distance) as i32;

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

    let summary = format!("direction='{}', distance={:.1}", params.direction, distance);
    let payload = SwipePayload {
        from,
        to,
        duration_ms: duration_ms_param,
    };

    let start = now_millis();
    let envelope = Envelope::new(MessageType::Swipe(payload))
        .with_target(target)
        .with_skip_wait(skip_wait);
    let response = server.send_and_wait(envelope).await?;
    let action_duration_ms = now_millis() - start;

    let success = matches!(&response.message, MessageType::ActionResult(r) if r.success);
    let mut mem = server.memory.lock().await;
    let current_app = mem.current_app.clone();
    mem.record_action(ActionRecord {
        timestamp: now_millis(),
        tool_name: "device_swipe".to_string(),
        params_summary: summary,
        success,
        app_package: current_app,
        duration_ms: action_duration_ms,
    });
    drop(mem);

    server.handle_action_response(response)
}

fn tap_summary(params: &TapParams) -> String {
    if let Some(ref t) = params.text {
        return format!("text='{}'", truncate(t, 30));
    }
    if let Some(ref t) = params.text_contains {
        return format!("text_contains='{}'", truncate(t, 30));
    }
    if let Some(ref d) = params.desc {
        return format!("desc='{}'", truncate(d, 30));
    }
    if let Some(ref r) = params.resource_id {
        return format!("resource_id='{}'", truncate(r, 40));
    }
    if let Some(coords) = params.coordinates {
        return format!("coords=[{},{}]", coords[0], coords[1]);
    }
    "no selector".to_string()
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}...", &s[..max])
    }
}

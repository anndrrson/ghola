use rmcp::{model::*, ErrorData};
use ghola_assistant_types::*;

use crate::memory::{now_millis, ScreenSnapshot};
use crate::{DeviceHistoryParams, SmartReadParams, ThumperServer};

pub(crate) async fn device_history(
    server: &ThumperServer,
    params: DeviceHistoryParams,
) -> Result<CallToolResult, ErrorData> {
    let n = params.limit.unwrap_or(20).min(100) as usize;
    let mem = server.memory.lock().await;
    let actions = mem.recent_actions(n);

    Ok(CallToolResult::success(vec![Content::text(
        serde_json::to_string_pretty(&actions).unwrap_or_else(|_| "[]".to_string()),
    )]))
}

pub(crate) async fn device_smart_read(
    server: &ThumperServer,
    params: SmartReadParams,
) -> Result<CallToolResult, ErrorData> {
    let target = server.resolve_target(params.device.as_deref());

    // Step 1: Read the accessibility tree
    let make_envelope = || Envelope::new(MessageType::ReadScreen).with_target(target.clone());
    let screen_response = server.send_and_wait_with_retry(make_envelope, 2).await?;

    let node_count = match &screen_response.message {
        MessageType::ScreenState(state) => {
            // Record screen in memory
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

            state.nodes.len()
        }
        MessageType::Error(e) => {
            return Err(ErrorData::internal_error(
                format!("device error: {} - {}", e.code, e.message),
                None,
            ));
        }
        _ => {
            return Err(ErrorData::internal_error("unexpected response type", None));
        }
    };

    // Step 2: If fewer than 5 nodes, also take a screenshot (WebView/Flutter/game)
    if node_count < 5 {
        let screenshot_params = ScreenshotParams {
            scale: 0.75,
            quality: 70,
        };
        let screenshot_envelope =
            Envelope::new(MessageType::TakeScreenshot(screenshot_params)).with_target(target);

        match server.send_and_wait(screenshot_envelope).await {
            Ok(screenshot_response) => {
                let mut contents = Vec::new();

                // Add the screen tree first
                if let MessageType::ScreenState(state) = screen_response.message {
                    contents.push(Content::text(format!(
                        "Accessibility tree ({} nodes - sparse, screenshot attached):\n{}",
                        node_count,
                        serde_json::to_string_pretty(&state).unwrap_or_default()
                    )));
                }

                // Add the screenshot
                if let MessageType::ScreenshotResult(result) = screenshot_response.message {
                    contents
                        .push(Content::image(result.image_base64, &result.mime_type));
                }

                return Ok(CallToolResult::success(contents));
            }
            Err(e) => {
                tracing::warn!("smart_read screenshot failed: {:?}, returning tree only", e);
                // Fall through to return just the tree
            }
        }
    }

    // Return just the accessibility tree (enough nodes for reliable interaction)
    server.handle_screen_response(screen_response)
}

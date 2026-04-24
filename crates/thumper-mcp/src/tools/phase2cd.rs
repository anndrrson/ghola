use rmcp::{model::*, ErrorData};
use thumper_types::*;

use crate::{DismissNotificationParams, ListDevicesParams, ReadNotificationsParams, ThumperServer};

pub(crate) async fn device_list_devices(
    server: &ThumperServer,
    _params: ListDevicesParams,
) -> Result<CallToolResult, ErrorData> {
    let envelope = Envelope::new(MessageType::ListConnectedDevices);
    let response = server.send_and_wait(envelope).await?;

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

pub(crate) async fn device_read_notifications(
    server: &ThumperServer,
    params: ReadNotificationsParams,
) -> Result<CallToolResult, ErrorData> {
    let target = server.resolve_target(params.device.as_deref());
    let payload = ReadNotificationsPayload {
        limit: params.limit.unwrap_or(20),
    };

    let envelope = Envelope::new(MessageType::ReadNotifications(payload)).with_target(target);
    let response = server.send_and_wait(envelope).await?;

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

pub(crate) async fn device_dismiss_notification(
    server: &ThumperServer,
    params: DismissNotificationParams,
) -> Result<CallToolResult, ErrorData> {
    let target = server.resolve_target(params.device.as_deref());
    let payload = DismissNotificationPayload { key: params.key };

    let envelope = Envelope::new(MessageType::DismissNotification(payload)).with_target(target);
    let response = server.send_and_wait(envelope).await?;
    server.handle_action_response(response)
}

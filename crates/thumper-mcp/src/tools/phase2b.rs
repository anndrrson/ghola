use std::time::Duration;

use rmcp::{model::*, ErrorData};
use thumper_types::*;

use crate::{ExecuteFlowParams, ListFlowsParams, ThumperServer};

pub(crate) async fn device_execute_flow(
    server: &ThumperServer,
    params: ExecuteFlowParams,
) -> Result<CallToolResult, ErrorData> {
    let target = server.resolve_target(params.device.as_deref());
    let flow = server
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

    // Flow execution can take a while -- use generous timeout
    let timeout = Duration::from_secs(120);

    let conn = server.connection.lock().await;
    let conn = conn
        .as_ref()
        .ok_or_else(|| ErrorData::internal_error("not connected to relay", None))?;

    let response = conn
        .send_command(envelope, timeout)
        .await
        .map_err(|e| ErrorData::internal_error(format!("relay error: {}", e), None))?;

    match response.message {
        MessageType::FlowResult(result) => Ok(CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&result).unwrap_or_default(),
        )])),
        MessageType::Error(e) => Err(ErrorData::internal_error(
            format!("device error: {} - {}", e.code, e.message),
            None,
        )),
        _ => Err(ErrorData::internal_error("unexpected response type", None)),
    }
}

pub(crate) async fn device_list_flows(
    server: &ThumperServer,
    _params: ListFlowsParams,
) -> Result<CallToolResult, ErrorData> {
    let flows = server.flow_registry.list();
    Ok(CallToolResult::success(vec![Content::text(
        serde_json::to_string_pretty(&flows).unwrap_or_default(),
    )]))
}

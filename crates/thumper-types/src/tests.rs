use super::*;

// -- Envelope tests --

#[test]
fn envelope_roundtrip_read_screen() {
    let env = Envelope::new(MessageType::ReadScreen);
    let json = serde_json::to_string(&env).unwrap();
    let decoded: Envelope = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.id, env.id);
    assert!(matches!(decoded.message, MessageType::ReadScreen));
    assert!(decoded.source.is_none());
    assert!(decoded.target.is_none());
}

#[test]
fn envelope_with_target_and_source() {
    let env = Envelope::new(MessageType::Ping)
        .with_target("device123".into())
        .with_source("mcp456".into());
    assert_eq!(env.target.as_deref(), Some("device123"));
    assert_eq!(env.source.as_deref(), Some("mcp456"));
}

#[test]
fn envelope_response_swaps_source_target() {
    let env = Envelope::new(MessageType::ReadScreen)
        .with_target("device".into())
        .with_source("mcp".into());

    let resp = env.response(MessageType::Pong);
    assert_eq!(resp.id, env.id);
    assert_eq!(resp.source.as_deref(), Some("device"));
    assert_eq!(resp.target.as_deref(), Some("mcp"));
}

#[test]
fn envelope_response_preserves_correlation_id() {
    let env = Envelope::new(MessageType::Ping);
    let resp = env.response(MessageType::Pong);
    assert_eq!(resp.id, env.id);
}

// -- MessageType serialization roundtrips --

#[test]
fn message_type_roundtrip_ping_pong() {
    let msgs = vec![MessageType::Ping, MessageType::Pong];
    for msg in msgs {
        let json = serde_json::to_string(&msg).unwrap();
        let decoded: MessageType = serde_json::from_str(&json).unwrap();
        assert_eq!(
            std::mem::discriminant(&msg),
            std::mem::discriminant(&decoded)
        );
    }
}

#[test]
fn message_type_roundtrip_tap() {
    let selector = NodeSelector {
        text: Some("Send".into()),
        text_contains: None,
        desc: None,
        desc_contains: None,
        resource_id: None,
        class: None,
        clickable: Some(true),
        coordinates: None,
    };
    let msg = MessageType::Tap(selector);
    let json = serde_json::to_string(&msg).unwrap();
    let decoded: MessageType = serde_json::from_str(&json).unwrap();
    match decoded {
        MessageType::Tap(sel) => {
            assert_eq!(sel.text.as_deref(), Some("Send"));
            assert_eq!(sel.clickable, Some(true));
        }
        _ => panic!("expected Tap"),
    }
}

#[test]
fn message_type_roundtrip_type_text() {
    let payload = TypeTextPayload {
        selector: NodeSelector {
            text: None,
            text_contains: None,
            desc: Some("amount field".into()),
            desc_contains: None,
            resource_id: None,
            class: None,
            clickable: None,
            coordinates: None,
        },
        text: "100".into(),
    };
    let msg = MessageType::TypeText(payload);
    let json = serde_json::to_string(&msg).unwrap();
    let decoded: MessageType = serde_json::from_str(&json).unwrap();
    match decoded {
        MessageType::TypeText(p) => {
            assert_eq!(p.text, "100");
            assert_eq!(p.selector.desc.as_deref(), Some("amount field"));
        }
        _ => panic!("expected TypeText"),
    }
}

#[test]
fn message_type_roundtrip_launch_app() {
    let msg = MessageType::LaunchApp(LaunchAppPayload {
        package: "app.phantom".into(),
    });
    let json = serde_json::to_string(&msg).unwrap();
    let decoded: MessageType = serde_json::from_str(&json).unwrap();
    match decoded {
        MessageType::LaunchApp(p) => assert_eq!(p.package, "app.phantom"),
        _ => panic!("expected LaunchApp"),
    }
}

#[test]
fn message_type_roundtrip_swipe() {
    let msg = MessageType::Swipe(SwipePayload {
        from: [540, 1800],
        to: [540, 600],
        duration_ms: 300,
    });
    let json = serde_json::to_string(&msg).unwrap();
    let decoded: MessageType = serde_json::from_str(&json).unwrap();
    match decoded {
        MessageType::Swipe(p) => {
            assert_eq!(p.from, [540, 1800]);
            assert_eq!(p.to, [540, 600]);
            assert_eq!(p.duration_ms, 300);
        }
        _ => panic!("expected Swipe"),
    }
}

#[test]
fn message_type_roundtrip_screenshot_params() {
    let msg = MessageType::TakeScreenshot(ScreenshotParams {
        scale: 0.5,
        quality: 50,
    });
    let json = serde_json::to_string(&msg).unwrap();
    let decoded: MessageType = serde_json::from_str(&json).unwrap();
    match decoded {
        MessageType::TakeScreenshot(p) => {
            assert!((p.scale - 0.5).abs() < f64::EPSILON);
            assert_eq!(p.quality, 50);
        }
        _ => panic!("expected TakeScreenshot"),
    }
}

#[test]
fn message_type_roundtrip_scroll() {
    let msg = MessageType::Scroll(ScrollPayload {
        selector: None,
        direction: ScrollDirection::Down,
    });
    let json = serde_json::to_string(&msg).unwrap();
    let decoded: MessageType = serde_json::from_str(&json).unwrap();
    match decoded {
        MessageType::Scroll(p) => {
            assert!(p.selector.is_none());
            assert!(matches!(p.direction, ScrollDirection::Down));
        }
        _ => panic!("expected Scroll"),
    }
}

#[test]
fn message_type_roundtrip_global_action() {
    for action in [
        GlobalAction::Home,
        GlobalAction::Recents,
        GlobalAction::Notifications,
        GlobalAction::QuickSettings,
        GlobalAction::PowerDialog,
    ] {
        let msg = MessageType::GlobalAction(GlobalActionPayload {
            action: action.clone(),
        });
        let json = serde_json::to_string(&msg).unwrap();
        let _decoded: MessageType = serde_json::from_str(&json).unwrap();
    }
}

#[test]
fn message_type_roundtrip_device_info_result() {
    let info = DeviceInfo {
        model: "Seeker".into(),
        manufacturer: "Solana".into(),
        android_version: "14".into(),
        sdk_version: 34,
        screen_width: 1080,
        screen_height: 2400,
        screen_density: 2.75,
        battery_level: 85,
        battery_charging: true,
        wifi_connected: true,
        cellular_connected: false,
    };
    let msg = MessageType::DeviceInfoResult(info);
    let json = serde_json::to_string(&msg).unwrap();
    let decoded: MessageType = serde_json::from_str(&json).unwrap();
    match decoded {
        MessageType::DeviceInfoResult(i) => {
            assert_eq!(i.model, "Seeker");
            assert_eq!(i.sdk_version, 34);
            assert_eq!(i.battery_level, 85);
        }
        _ => panic!("expected DeviceInfoResult"),
    }
}

#[test]
fn message_type_roundtrip_screen_state() {
    let state = ScreenState {
        package: "app.phantom".into(),
        activity: Some("MainActivity".into()),
        nodes: vec![UiNode {
            index: 0,
            class: "android.widget.Button".into(),
            text: Some("Send".into()),
            desc: None,
            resource_id: Some("com.phantom:id/btn_send".into()),
            bounds: [100, 200, 300, 250],
            clickable: true,
            focusable: true,
            editable: false,
            checked: None,
            enabled: true,
            depth: 3,
        }],
    };
    let msg = MessageType::ScreenState(state);
    let json = serde_json::to_string(&msg).unwrap();
    let decoded: MessageType = serde_json::from_str(&json).unwrap();
    match decoded {
        MessageType::ScreenState(s) => {
            assert_eq!(s.package, "app.phantom");
            assert_eq!(s.nodes.len(), 1);
            assert_eq!(s.nodes[0].text.as_deref(), Some("Send"));
            assert!(s.nodes[0].clickable);
            assert_eq!(s.nodes[0].bounds, [100, 200, 300, 250]);
        }
        _ => panic!("expected ScreenState"),
    }
}

#[test]
fn message_type_roundtrip_action_result() {
    let msg = MessageType::ActionResult(ActionResult {
        success: true,
        message: Some("tapped element".into()),
        screen_after: None,
    });
    let json = serde_json::to_string(&msg).unwrap();
    let decoded: MessageType = serde_json::from_str(&json).unwrap();
    match decoded {
        MessageType::ActionResult(r) => {
            assert!(r.success);
            assert_eq!(r.message.as_deref(), Some("tapped element"));
        }
        _ => panic!("expected ActionResult"),
    }
}

#[test]
fn message_type_roundtrip_flow_result() {
    let msg = MessageType::FlowResult(FlowResult {
        success: false,
        steps_completed: 3,
        total_steps: 8,
        final_screen: None,
        error: Some("element not found".into()),
        failed_step: Some(3),
        error_screenshot: None,
    });
    let json = serde_json::to_string(&msg).unwrap();
    let decoded: MessageType = serde_json::from_str(&json).unwrap();
    match decoded {
        MessageType::FlowResult(r) => {
            assert!(!r.success);
            assert_eq!(r.steps_completed, 3);
            assert_eq!(r.total_steps, 8);
            assert_eq!(r.failed_step, Some(3));
            assert_eq!(r.error.as_deref(), Some("element not found"));
        }
        _ => panic!("expected FlowResult"),
    }
}

#[test]
fn message_type_roundtrip_notifications() {
    let msg = MessageType::NotificationsResult(NotificationsResult {
        notifications: vec![NotificationEntry {
            key: "0|com.app|123".into(),
            package: "com.app".into(),
            title: Some("New message".into()),
            text: Some("Hello world".into()),
            timestamp: 1700000000000,
        }],
    });
    let json = serde_json::to_string(&msg).unwrap();
    let decoded: MessageType = serde_json::from_str(&json).unwrap();
    match decoded {
        MessageType::NotificationsResult(r) => {
            assert_eq!(r.notifications.len(), 1);
            assert_eq!(r.notifications[0].package, "com.app");
            assert_eq!(r.notifications[0].title.as_deref(), Some("New message"));
        }
        _ => panic!("expected NotificationsResult"),
    }
}

#[test]
fn message_type_roundtrip_connected_devices() {
    let msg = MessageType::ConnectedDevicesResult(ConnectedDevicesResult {
        devices: vec![
            ConnectedDevice {
                pubkey: "abc123".into(),
                label: Some("Solana Seeker (Android 14)".into()),
            },
            ConnectedDevice {
                pubkey: "def456".into(),
                label: None,
            },
        ],
    });
    let json = serde_json::to_string(&msg).unwrap();
    let decoded: MessageType = serde_json::from_str(&json).unwrap();
    match decoded {
        MessageType::ConnectedDevicesResult(r) => {
            assert_eq!(r.devices.len(), 2);
            assert_eq!(r.devices[0].pubkey, "abc123");
            assert!(r.devices[0].label.is_some());
            assert!(r.devices[1].label.is_none());
        }
        _ => panic!("expected ConnectedDevicesResult"),
    }
}

// -- NodeSelector tests --

#[test]
fn node_selector_optional_fields_omitted_in_json() {
    let selector = NodeSelector {
        text: Some("OK".into()),
        text_contains: None,
        desc: None,
        desc_contains: None,
        resource_id: None,
        class: None,
        clickable: None,
        coordinates: None,
    };
    let json = serde_json::to_string(&selector).unwrap();
    assert!(json.contains("\"text\":\"OK\""));
    assert!(!json.contains("text_contains"));
    assert!(!json.contains("coordinates"));
}

#[test]
fn node_selector_coordinates_roundtrip() {
    let selector = NodeSelector {
        text: None,
        text_contains: None,
        desc: None,
        desc_contains: None,
        resource_id: None,
        class: None,
        clickable: None,
        coordinates: Some([540, 1200]),
    };
    let json = serde_json::to_string(&selector).unwrap();
    let decoded: NodeSelector = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.coordinates, Some([540, 1200]));
}

// -- Default value tests --

#[test]
fn screenshot_params_defaults() {
    let params = ScreenshotParams::default();
    assert!((params.scale - 0.5).abs() < f64::EPSILON);
    assert_eq!(params.quality, 50);
}

#[test]
fn swipe_duration_default() {
    let json = r#"{"from":[0,0],"to":[100,100]}"#;
    let payload: SwipePayload = serde_json::from_str(json).unwrap();
    assert_eq!(payload.duration_ms, 300);
}

#[test]
fn wait_for_payload_defaults() {
    let json = r#"{"selector":{"text":"OK"}}"#;
    let payload: WaitForPayload = serde_json::from_str(json).unwrap();
    assert_eq!(payload.timeout_ms, 10000);
    assert_eq!(payload.poll_interval_ms, 500);
}

#[test]
fn long_press_duration_default() {
    let json = r#"{"selector":{"text":"item"}}"#;
    let payload: LongPressPayload = serde_json::from_str(json).unwrap();
    assert_eq!(payload.duration_ms, 500);
}

#[test]
fn notification_limit_default() {
    let json = "{}";
    let payload: ReadNotificationsPayload = serde_json::from_str(json).unwrap();
    assert_eq!(payload.limit, 20);
}

// -- Auth tests --

#[test]
fn auth_message_canonical_bytes() {
    let msg = AuthMessage {
        pubkey: "abc123".into(),
        timestamp: 1700000000,
        nonce: "test-nonce".into(),
        role: ConnectionRole::Device,
    };
    let bytes = msg.canonical_bytes();
    let expected = "thumper-auth:abc123:1700000000:test-nonce:device";
    assert_eq!(bytes, expected.as_bytes());
}

#[test]
fn auth_message_canonical_bytes_mcp_client() {
    let msg = AuthMessage {
        pubkey: "mcp456".into(),
        timestamp: 1700000001,
        nonce: "nonce2".into(),
        role: ConnectionRole::McpClient,
    };
    let bytes = msg.canonical_bytes();
    let expected = "thumper-auth:mcp456:1700000001:nonce2:mcp_client";
    assert_eq!(bytes, expected.as_bytes());
}

#[test]
fn auth_payload_roundtrip() {
    let payload = AuthPayload {
        message: AuthMessage {
            pubkey: "testkey".into(),
            timestamp: 1700000000,
            nonce: "uuid-here".into(),
            role: ConnectionRole::Device,
        },
        signature: "base64sig".into(),
    };
    let json = serde_json::to_string(&payload).unwrap();
    let decoded: AuthPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.message.pubkey, "testkey");
    assert_eq!(decoded.signature, "base64sig");
    assert!(matches!(decoded.message.role, ConnectionRole::Device));
}

#[test]
fn connection_role_serialization() {
    let device = ConnectionRole::Device;
    let mcp = ConnectionRole::McpClient;
    assert_eq!(serde_json::to_string(&device).unwrap(), "\"device\"");
    assert_eq!(serde_json::to_string(&mcp).unwrap(), "\"mcp_client\"");
}

// -- Flow definition tests --

#[test]
fn flow_definition_roundtrip() {
    let flow = FlowDefinition {
        name: "test_flow".into(),
        description: "A test flow".into(),
        params: vec![FlowParam {
            name: "recipient".into(),
            description: "wallet address".into(),
            required: true,
            default: None,
        }],
        steps: vec![
            FlowStep {
                label: Some("Launch app".into()),
                action: FlowAction::LaunchApp {
                    package: "app.phantom".into(),
                },
                wait_for: None,
                on_failure: FailureStrategy::Abort,
                timeout_ms: None,
            },
            FlowStep {
                label: Some("Tap send".into()),
                action: FlowAction::Tap {
                    selector: NodeSelector {
                        text: Some("Send".into()),
                        text_contains: None,
                        desc: None,
                        desc_contains: None,
                        resource_id: None,
                        class: None,
                        clickable: None,
                        coordinates: None,
                    },
                },
                wait_for: Some(WaitCondition {
                    selector: NodeSelector {
                        text: None,
                        text_contains: Some("recipient".into()),
                        desc: None,
                        desc_contains: None,
                        resource_id: None,
                        class: None,
                        clickable: None,
                        coordinates: None,
                    },
                    timeout_ms: 5000,
                    poll_interval_ms: 500,
                }),
                on_failure: FailureStrategy::Retry {
                    max_attempts: 3,
                    delay_ms: 1000,
                },
                timeout_ms: Some(5000),
            },
        ],
    };
    let json = serde_json::to_string_pretty(&flow).unwrap();
    let decoded: FlowDefinition = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.name, "test_flow");
    assert_eq!(decoded.params.len(), 1);
    assert_eq!(decoded.steps.len(), 2);
    assert!(decoded.params[0].required);
}

#[test]
fn flow_action_all_variants_serialize() {
    let actions: Vec<FlowAction> = vec![
        FlowAction::LaunchApp {
            package: "com.test".into(),
        },
        FlowAction::Tap {
            selector: NodeSelector {
                text: Some("OK".into()),
                text_contains: None,
                desc: None,
                desc_contains: None,
                resource_id: None,
                class: None,
                clickable: None,
                coordinates: None,
            },
        },
        FlowAction::LongPress {
            selector: NodeSelector {
                text: None,
                text_contains: None,
                desc: None,
                desc_contains: None,
                resource_id: None,
                class: None,
                clickable: None,
                coordinates: Some([100, 200]),
            },
            duration_ms: Some(1000),
        },
        FlowAction::TypeText {
            selector: NodeSelector {
                text: None,
                text_contains: None,
                desc: Some("input".into()),
                desc_contains: None,
                resource_id: None,
                class: None,
                clickable: None,
                coordinates: None,
            },
            value: "hello".into(),
        },
        FlowAction::Swipe {
            from: [540, 1800],
            to: [540, 600],
            duration_ms: Some(300),
        },
        FlowAction::Scroll {
            selector: None,
            direction: ScrollDirection::Down,
        },
        FlowAction::WaitFor {
            selector: NodeSelector {
                text: Some("Done".into()),
                text_contains: None,
                desc: None,
                desc_contains: None,
                resource_id: None,
                class: None,
                clickable: None,
                coordinates: None,
            },
            timeout_ms: 5000,
        },
        FlowAction::PressBack,
        FlowAction::ReadScreen,
        FlowAction::Delay { ms: 1000 },
    ];

    for action in actions {
        let json = serde_json::to_string(&action).unwrap();
        let _decoded: FlowAction = serde_json::from_str(&json).unwrap();
    }
}

#[test]
fn failure_strategy_default_is_abort() {
    let strategy = FailureStrategy::default();
    assert!(matches!(strategy, FailureStrategy::Abort));
}

#[test]
fn failure_strategy_variants_serialize() {
    let strategies = vec![
        FailureStrategy::Abort,
        FailureStrategy::Skip,
        FailureStrategy::Retry {
            max_attempts: 3,
            delay_ms: 500,
        },
    ];
    for s in strategies {
        let json = serde_json::to_string(&s).unwrap();
        let _decoded: FailureStrategy = serde_json::from_str(&json).unwrap();
    }
}

#[test]
fn wait_condition_defaults() {
    let json = r#"{"selector":{"text":"OK"}}"#;
    let cond: WaitCondition = serde_json::from_str(json).unwrap();
    assert_eq!(cond.timeout_ms, 10000);
    assert_eq!(cond.poll_interval_ms, 500);
}

// -- Error payload test --

#[test]
fn error_payload_roundtrip() {
    let msg = MessageType::Error(ErrorPayload {
        code: "device_offline".into(),
        message: "target device is not connected".into(),
    });
    let json = serde_json::to_string(&msg).unwrap();
    let decoded: MessageType = serde_json::from_str(&json).unwrap();
    match decoded {
        MessageType::Error(e) => {
            assert_eq!(e.code, "device_offline");
            assert_eq!(e.message, "target device is not connected");
        }
        _ => panic!("expected Error"),
    }
}

// -- Full envelope roundtrip with complex payload --

#[test]
fn full_envelope_roundtrip_execute_flow() {
    let flow = FlowDefinition {
        name: "send_token".into(),
        description: "Send tokens".into(),
        params: vec![],
        steps: vec![FlowStep {
            label: None,
            action: FlowAction::LaunchApp {
                package: "app.phantom".into(),
            },
            wait_for: None,
            on_failure: FailureStrategy::Abort,
            timeout_ms: None,
        }],
    };
    let payload = FlowExecutePayload {
        flow,
        params: [("amount".to_string(), "1.5".to_string())]
            .into_iter()
            .collect(),
    };
    let env = Envelope::new(MessageType::ExecuteFlow(payload))
        .with_target("device123".into())
        .with_source("mcp456".into());

    let json = serde_json::to_string(&env).unwrap();
    let decoded: Envelope = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.id, env.id);
    assert_eq!(decoded.target.as_deref(), Some("device123"));
    match decoded.message {
        MessageType::ExecuteFlow(p) => {
            assert_eq!(p.flow.name, "send_token");
            assert_eq!(p.params.get("amount").map(String::as_str), Some("1.5"));
        }
        _ => panic!("expected ExecuteFlow"),
    }
}

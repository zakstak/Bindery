use std::time::Duration;

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::Path,
    response::{Html, IntoResponse},
    routing::get,
    Router,
};
use serde_json::{json, Value};
use tokio::time::sleep;
use tracing::{info, warn};

/// Mock routes for testing the real shell without a live agent process.
pub fn router() -> Router {
    Router::new()
        .route("/ws/mock", get(ws_handler))
        .route("/api/mock/inspect/:agent_id", get(inspect_handler))
}

async fn ws_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(handle_mock_socket)
}

async fn handle_mock_socket(mut socket: WebSocket) {
    info!("mock websocket connected");

    let mut model = json!({ "provider": "mock", "id": "bindery-demo-orchestrator-v2" });
    let mut prompt_index: u32 = 0;
    let mut boot_sent = false;

    while let Some(message) = socket.recv().await {
        let text = match message {
            Ok(Message::Text(text)) => text,
            Ok(Message::Close(_)) => break,
            Ok(_) => continue,
            Err(error) => {
                warn!("mock websocket receive error: {error}");
                return;
            }
        };

        let command: Value = match serde_json::from_str(&text) {
            Ok(value) => value,
            Err(error) => {
                warn!("mock websocket invalid json: {error}");
                if send_json(
                    &mut socket,
                    json!({
                        "type": "response",
                        "command": "unknown",
                        "success": false,
                        "error": "invalid json command",
                    }),
                )
                .await
                .is_err()
                {
                    return;
                }
                continue;
            }
        };

        let command_type = command
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();

        match command_type {
            "get_state" => {
                if send_json(
                    &mut socket,
                    json!({
                        "type": "response",
                        "command": "get_state",
                        "success": true,
                        "data": {
                            "sessionName": "Bindery demo session",
                            "model": model.clone(),
                            "isStreaming": false,
                            "contextPercent": 18,
                        }
                    }),
                )
                .await
                .is_err()
                {
                    return;
                }

                if !boot_sent {
                    boot_sent = true;
                    if !play_sequence(&mut socket, build_boot_sequence()).await {
                        return;
                    }
                }
            }
            "set_model" => {
                let provider = command
                    .get("provider")
                    .and_then(Value::as_str)
                    .unwrap_or("mock");
                let model_id = command
                    .get("modelId")
                    .or_else(|| command.get("model_id"))
                    .and_then(Value::as_str)
                    .unwrap_or("bindery-demo-orchestrator-v2");

                model = json!({ "provider": provider, "id": model_id });

                if send_json(
                    &mut socket,
                    json!({
                        "type": "response",
                        "command": "set_model",
                        "success": true,
                        "data": model.clone(),
                    }),
                )
                .await
                .is_err()
                {
                    return;
                }

                if send_json(
                    &mut socket,
                    json!({
                        "type": "model_select",
                        "model": model.clone(),
                    }),
                )
                .await
                .is_err()
                {
                    return;
                }
            }
            "prompt" => {
                let user_prompt = command
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string();

                if user_prompt.is_empty() {
                    if send_json(
                        &mut socket,
                        json!({
                            "type": "response",
                            "command": "prompt",
                            "success": false,
                            "error": "message is required",
                        }),
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                    continue;
                }

                prompt_index += 1;

                if send_json(
                    &mut socket,
                    json!({
                        "type": "response",
                        "command": "prompt",
                        "success": true,
                        "data": { "accepted": true, "isStreaming": true },
                    }),
                )
                .await
                .is_err()
                {
                    return;
                }

                if !play_sequence(
                    &mut socket,
                    build_prompt_sequence(prompt_index, &user_prompt, &model),
                )
                .await
                {
                    return;
                }
            }
            "abort" => {
                if send_json(
                    &mut socket,
                    json!({
                        "type": "response",
                        "command": "abort",
                        "success": true,
                        "data": { "isStreaming": false },
                    }),
                )
                .await
                .is_err()
                {
                    return;
                }
            }
            "extension_ui_response" => {
                if send_json(
                    &mut socket,
                    json!({
                        "type": "response",
                        "command": "extension_ui_response",
                        "success": true,
                    }),
                )
                .await
                .is_err()
                {
                    return;
                }
            }
            _ => {
                if send_json(
                    &mut socket,
                    json!({
                        "type": "response",
                        "command": command_type,
                        "success": false,
                        "error": "unsupported command in mock websocket",
                    }),
                )
                .await
                .is_err()
                {
                    return;
                }
            }
        }
    }

    info!("mock websocket disconnected");
}

async fn inspect_handler(Path(agent_id): Path<String>) -> Html<String> {
    Html(format!(
        "<div style=\"font-family:monospace;color:#908ca5\">mock inspector: {agent_id}</div>"
    ))
}

struct MockEvent {
    delay: Duration,
    payload: Value,
}

fn ms(value: u64) -> Duration {
    Duration::from_millis(value)
}

async fn play_sequence(socket: &mut WebSocket, events: Vec<MockEvent>) -> bool {
    for event in events {
        sleep(event.delay).await;
        if send_json(socket, event.payload).await.is_err() {
            return false;
        }
    }
    true
}

async fn send_json(socket: &mut WebSocket, payload: Value) -> Result<(), ()> {
    let text = serde_json::to_string(&payload).map_err(|_| ())?;
    socket.send(Message::Text(text.into())).await.map_err(|_| ())
}

fn build_boot_sequence() -> Vec<MockEvent> {
    vec![
        MockEvent {
            delay: ms(90),
            payload: json!({
                "type": "extension_ui_request",
                "method": "setTitle",
                "title": "Bindery demo - Release concierge",
            }),
        },
        MockEvent {
            delay: ms(80),
            payload: json!({
                "type": "extension_ui_request",
                "method": "notify",
                "message": "Demo loaded: send any product request to watch Bindery orchestrate tools and UI updates.",
            }),
        },
        MockEvent {
            delay: ms(80),
            payload: json!({
                "type": "extension_ui_request",
                "method": "setWidget",
                "widgetLines": [
                    "Bindery demo board",
                    "Mode: mock /ws/mock transport",
                    "State: ready for first request",
                    "Focus: orchestration narrative"
                ],
            }),
        },
        MockEvent {
            delay: ms(90),
            payload: json!({
                "type": "message_start",
                "message": {
                    "id": "mock-welcome",
                    "role": "assistant",
                    "content": [
                        { "type": "text", "text": "Welcome to the Bindery shell demo. I can turn a rough request into a coordinated plan with tool steps, UI updates, and a final brief." }
                    ]
                },
            }),
        },
        MockEvent {
            delay: ms(110),
            payload: json!({
                "type": "message_end",
                "message": {
                    "id": "mock-welcome",
                    "role": "assistant",
                    "content": [
                        { "type": "text", "text": "Welcome to the Bindery shell demo. I can turn a rough request into a coordinated plan with tool steps, UI updates, and a final brief." }
                    ]
                },
                "usage": { "inputTokens": 30, "outputTokens": 31 },
                "contextPercent": 20,
            }),
        },
    ]
}

fn build_prompt_sequence(prompt_index: u32, prompt: &str, model: &Value) -> Vec<MockEvent> {
    let turn_label = format!("mock-turn-{prompt_index}");
    let user_message_id = format!("mock-user-{prompt_index}");
    let assistant_message_id = format!("mock-assistant-{prompt_index}");
    let user_text = prompt.to_string();
    let kickoff_text = format!(
        "Got it. I will orchestrate this as a release concierge run: {prompt}"
    );
    let progress_text =
        "Status update: intake complete, dependency scan done, and risk checks are now running.";
    let final_text = format!(
        "Launch brief ready.\n\nObjective\n- {}\n\nOrchestration flow\n- Parsed goal and constraints from your request\n- Inspected shell/event surfaces and mock storyline touchpoints\n- Ran validation checkpoints for compile, test, and UI walkthrough\n\nRecommendation\n- Ship the refined shared shell with clearer event semantics\n- Keep /ws and /ws/mock on the same client contract\n- Use this mock sequence for stakeholder demos because it shows agent, tool, UI notify/update, and final assistant synthesis in one pass.",
        prompt
    );
    let context_percent = 26_u32.saturating_add((prompt_index.saturating_mul(7)).min(46));

    vec![
        MockEvent {
            delay: ms(70),
            payload: json!({
                "type": "agent_start",
                "agentId": "bindery-demo-agent",
                "label": turn_label.clone(),
                "contextPercent": context_percent,
            }),
        },
        MockEvent {
            delay: ms(80),
            payload: json!({
                "type": "turn_start",
                "turnIndex": prompt_index,
            }),
        },
        MockEvent {
            delay: ms(60),
            payload: json!({
                "type": "extension_ui_request",
                "method": "notify",
                "message": "Intake captured. Building an orchestration plan now.",
            }),
        },
        MockEvent {
            delay: ms(60),
            payload: json!({
                "type": "extension_ui_request",
                "method": "setWidget",
                "widgetLines": [
                    "Bindery demo board",
                    "Stage: intake",
                    "Status: running",
                    "Active lane: planner"
                ],
            }),
        },
        MockEvent {
            delay: ms(60),
            payload: json!({
                "type": "message_start",
                "message": {
                    "id": user_message_id.clone(),
                    "role": "user",
                    "content": [{ "type": "text", "text": user_text.clone() }],
                },
            }),
        },
        MockEvent {
            delay: ms(55),
            payload: json!({
                "type": "message_end",
                "message": {
                    "id": user_message_id,
                    "role": "user",
                    "content": [{ "type": "text", "text": user_text }],
                },
            }),
        },
        MockEvent {
            delay: ms(70),
            payload: json!({
                "type": "message_start",
                "message": {
                    "id": assistant_message_id.clone(),
                    "role": "assistant",
                    "content": [{ "type": "text", "text": kickoff_text }],
                },
            }),
        },
        MockEvent {
            delay: ms(90),
            payload: json!({
                "type": "tool_execution_start",
                "command": "read",
                "arguments": {
                    "path": "bindery/templates/index.html",
                    "purpose": "map stream row and inspector semantics"
                },
            }),
        },
        MockEvent {
            delay: ms(120),
            payload: json!({
                "type": "tool_execution_end",
                "command": "read",
                "success": true,
                "summary": "Found shared stream renderer and inspector pathways",
                "contextPercent": context_percent.saturating_add(5),
            }),
        },
        MockEvent {
            delay: ms(90),
            payload: json!({
                "type": "tool_execution_start",
                "command": "grep",
                "arguments": {
                    "pattern": "tool_execution_start|message_update|extension_ui_request",
                    "path": "bindery/src/web/mock.rs"
                },
            }),
        },
        MockEvent {
            delay: ms(100),
            payload: json!({
                "type": "tool_execution_end",
                "command": "grep",
                "success": true,
                "summary": "Confirmed event taxonomy coverage for message/tool/ui/response",
                "contextPercent": context_percent.saturating_add(9),
            }),
        },
        MockEvent {
            delay: ms(70),
            payload: json!({
                "type": "extension_ui_request",
                "method": "notify",
                "message": "Dependency scan done. Running verification checkpoint sequence.",
            }),
        },
        MockEvent {
            delay: ms(80),
            payload: json!({
                "type": "extension_ui_request",
                "method": "setWidget",
                "widgetLines": [
                    "Bindery demo board",
                    "Stage: verification",
                    "Status: running",
                    "Active lane: verifier",
                    "Last tool: grep mock.rs"
                ],
            }),
        },
        MockEvent {
            delay: ms(85),
            payload: json!({
                "type": "tool_execution_start",
                "command": "cargo_check",
                "arguments": {
                    "package": "bindery",
                    "focus": "ws live+mock contract"
                },
            }),
        },
        MockEvent {
            delay: ms(120),
            payload: json!({
                "type": "tool_execution_end",
                "command": "cargo_check",
                "success": true,
                "summary": "Package checks passed for bindery",
                "contextPercent": context_percent.saturating_add(12),
            }),
        },
        MockEvent {
            delay: ms(130),
            payload: json!({
                "type": "message_update",
                "message": {
                    "id": assistant_message_id.clone(),
                    "role": "assistant",
                    "content": [{ "type": "text", "text": progress_text }],
                },
            }),
        },
        MockEvent {
            delay: ms(75),
            payload: json!({
                "type": "extension_ui_request",
                "method": "notify",
                "message": "Composing final launch brief for handoff.",
            }),
        },
        MockEvent {
            delay: ms(80),
            payload: json!({
                "type": "extension_ui_request",
                "method": "setWidget",
                "widgetLines": [
                    "Bindery demo board",
                    "Stage: synthesis",
                    "Status: done",
                    "Active lane: narrator",
                    "Deliverable: launch brief ready"
                ],
            }),
        },
        MockEvent {
            delay: ms(140),
            payload: json!({
                "type": "message_end",
                "message": {
                    "id": assistant_message_id,
                    "role": "assistant",
                    "content": [{ "type": "text", "text": final_text }],
                },
                "usage": {
                    "inputTokens": 118_u64 + prompt.len() as u64,
                    "outputTokens": 168,
                },
                "contextPercent": context_percent.saturating_add(18),
            }),
        },
        MockEvent {
            delay: ms(70),
            payload: json!({
                "type": "model_select",
                "model": model.clone(),
            }),
        },
        MockEvent {
            delay: ms(80),
            payload: json!({
                "type": "turn_end",
                "turnIndex": prompt_index,
            }),
        },
        MockEvent {
            delay: ms(65),
            payload: json!({
                "type": "agent_end",
                "agentId": "bindery-demo-agent",
                "label": turn_label,
                "contextPercent": context_percent.saturating_add(18),
            }),
        },
    ]
}

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

struct MockTaskState {
    task_id: String,
    goal: String,
    completed: bool,
}

fn current_model_label(model: &Value) -> String {
    let provider = model.get("provider").and_then(Value::as_str).unwrap_or("mock");
    let id = model
        .get("id")
        .or_else(|| model.get("modelId"))
        .and_then(Value::as_str)
        .unwrap_or("bindery-demo-orchestrator-v2");
    format!("{provider}/{id}")
}

fn prompt_images(command: &Value) -> Vec<Value> {
    command
        .get("images")
        .and_then(Value::as_array)
        .map(|images| {
            images
                .iter()
                .filter(|image| image.is_object())
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

fn prompt_summary(prompt: &str, image_count: usize) -> String {
    let trimmed = prompt.trim();
    if !trimmed.is_empty() {
        if image_count > 0 {
            format!(
                "{trimmed} (+{image_count} image attachment{})",
                if image_count == 1 { "" } else { "s" }
            )
        } else {
            trimmed.to_string()
        }
    } else if image_count == 1 {
        String::from("Inspect the attached image.")
    } else {
        format!("Inspect the attached {image_count} images.")
    }
}

fn prompt_message_content(prompt: &str, images: &[Value]) -> Vec<Value> {
    let mut content = Vec::new();
    let trimmed = prompt.trim();
    if !trimmed.is_empty() {
        content.push(json!({ "type": "text", "text": trimmed }));
    }
    content.extend(images.iter().cloned());
    content
}

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
    let mut task_index: u32 = 0;
    let mut boot_sent = false;
    let mut session_name = String::from("Bindery demo session");
    let mut active_task: Option<MockTaskState> = None;

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
                            "sessionName": session_name,
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
                let prompt_images = prompt_images(&command);

                if user_prompt.is_empty() && prompt_images.is_empty() {
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

                // Detect special /test command for comprehensive sequence
                let sequence = if user_prompt == "/test" || user_prompt == "test all" {
                    build_comprehensive_sequence(&model)
                } else {
                    build_prompt_sequence(prompt_index, &user_prompt, &prompt_images, &model)
                };

                if !play_sequence(&mut socket, sequence).await {
                    return;
                }
            }
            "start_task_session" => {
                let goal = command
                    .get("goal")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string();

                if goal.is_empty() {
                    if send_json(
                        &mut socket,
                        json!({
                            "type": "response",
                            "command": "start_task_session",
                            "success": false,
                            "error": "goal is required",
                        }),
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                    continue;
                }

                task_index += 1;
                let task_id = format!("mock-task-{task_index}");
                session_name = format!("Task · {goal}");
                active_task = Some(MockTaskState {
                    task_id: task_id.clone(),
                    goal: goal.clone(),
                    completed: false,
                });

                if send_json(
                    &mut socket,
                    json!({
                        "type": "response",
                        "command": "start_task_session",
                        "success": true,
                        "data": {
                            "cancelled": false,
                            "packet": {
                                "schemaVersion": 1,
                                "taskId": task_id,
                                "createdAt": format!("mock-task-created-{task_index}"),
                                "parentSessionId": "mock-parent-session",
                                "parentSessionFile": "/tmp/mock-parent.jsonl",
                                "cwd": "/tmp/mock-project",
                                "model": current_model_label(&model),
                                "goal": goal,
                                "constraints": command.get("constraints").cloned().unwrap_or_else(|| json!([])),
                                "relevantFiles": [],
                                "doneDefinition": command.get("doneDefinition").or_else(|| command.get("done_definition")).and_then(Value::as_str).unwrap_or("Return one structured result summary with changed files, open risks, and the next recommended step."),
                                "notes": command.get("notes").cloned().unwrap_or(Value::Null),
                            },
                            "previousSessionFile": "/tmp/mock-parent.jsonl",
                            "nextSessionFile": format!("/tmp/mock-task-{task_index}.jsonl"),
                        }
                    }),
                )
                .await
                .is_err()
                {
                    return;
                }
            }
            "complete_task_session" => {
                let summary = command
                    .get("summary")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string();

                if summary.is_empty() {
                    if send_json(
                        &mut socket,
                        json!({
                            "type": "response",
                            "command": "complete_task_session",
                            "success": false,
                            "error": "summary is required",
                        }),
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                    continue;
                }

                let Some(mut task_state) = active_task.take() else {
                    if send_json(
                        &mut socket,
                        json!({
                            "type": "response",
                            "command": "complete_task_session",
                            "success": false,
                            "error": "no active task session",
                        }),
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                    continue;
                };

                if task_state.completed {
                    active_task = Some(task_state);
                    if send_json(
                        &mut socket,
                        json!({
                            "type": "response",
                            "command": "complete_task_session",
                            "success": false,
                            "error": "Task result already recorded for this task.",
                        }),
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                    continue;
                }

                let resume_parent = command
                    .get("resumeParent")
                    .or_else(|| command.get("resume_parent"))
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                let task_id = task_state.task_id.clone();

                if resume_parent {
                    session_name = String::from("Bindery demo session");
                } else {
                    task_state.completed = true;
                    session_name = format!("Task · {}", task_state.goal);
                    active_task = Some(task_state);
                }

                if send_json(
                    &mut socket,
                    json!({
                        "type": "response",
                        "command": "complete_task_session",
                        "success": true,
                        "data": {
                            "result": {
                                "schemaVersion": 1,
                                "taskId": task_id,
                                "createdAt": format!("mock-task-result-{task_index}"),
                                "childSessionId": format!("mock-child-session-{task_index}"),
                                "childSessionFile": format!("/tmp/mock-task-{task_index}.jsonl"),
                                "parentSessionFile": "/tmp/mock-parent.jsonl",
                                "model": current_model_label(&model),
                                "summary": summary,
                                "changedFiles": [],
                                "openRisks": command.get("openRisks").or_else(|| command.get("open_risks")).cloned().unwrap_or_else(|| json!([])),
                                "nextStep": command.get("nextStep").or_else(|| command.get("next_step")).and_then(Value::as_str).unwrap_or("Return to the parent session and continue from this result."),
                                "notes": command.get("notes").cloned().unwrap_or(Value::Null),
                            },
                            "resumedParent": resume_parent,
                            "parentSessionFile": "/tmp/mock-parent.jsonl",
                        }
                    }),
                )
                .await
                .is_err()
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

fn build_prompt_sequence(prompt_index: u32, prompt: &str, images: &[Value], model: &Value) -> Vec<MockEvent> {
    let turn_label = format!("mock-turn-{prompt_index}");
    let user_message_id = format!("mock-user-{prompt_index}");
    let assistant_message_id = format!("mock-assistant-{prompt_index}");
    let user_summary = prompt_summary(prompt, images.len());
    let user_content = prompt_message_content(prompt, images);
    let kickoff_text = if prompt.trim().is_empty() {
        format!(
            "Got it. I will inspect {} attached image{} and turn that into a coordinated plan with tool steps, UI updates, and a final brief.",
            images.len(),
            if images.len() == 1 { "" } else { "s" }
        )
    } else if images.is_empty() {
        format!("Got it. I will orchestrate this as a release concierge run: {prompt}")
    } else {
        format!(
            "Got it. I will orchestrate this as a release concierge run: {prompt} I will also inspect {} attached image{}.",
            images.len(),
            if images.len() == 1 { "" } else { "s" }
        )
    };
    let progress_text =
        "Status update: intake complete, dependency scan done, and risk checks are now running.";
    let final_text = format!(
        "Launch brief ready.\n\nObjective\n- {}\n\nOrchestration flow\n- Parsed goal and constraints from your request\n- Inspected shell/event surfaces and mock storyline touchpoints\n- Ran validation checkpoints for compile, test, and UI walkthrough\n\nRecommendation\n- Ship the refined shared shell with clearer event semantics\n- Keep /ws and /ws/mock on the same client contract\n- Use this mock sequence for stakeholder demos because it shows agent, tool, UI notify/update, and final assistant synthesis in one pass.",
        user_summary
    );
    let context_percent = 26_u32
        .saturating_add((prompt_index.saturating_mul(7)).min(46))
        .saturating_add((images.len() as u32).min(3) * 4);

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
                    "content": user_content.clone(),
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
                    "content": user_content,
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
                    "inputTokens": 118_u64 + prompt.len() as u64 + (images.len() as u64 * 768),
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

/// Comprehensive test sequence that exercises every event type the UI must handle.
/// Triggered by sending "/test" or "test all" in the mock prompt.
fn build_comprehensive_sequence(model: &Value) -> Vec<MockEvent> {
    let _model_label = current_model_label(model);
    vec![
        // ── agent_start ──
        MockEvent {
            delay: ms(50),
            payload: json!({
                "type": "agent_start",
                "agentId": "test-agent",
                "label": "comprehensive-test-run",
                "contextPercent": 5,
            }),
        },
        // ── turn_start ──
        MockEvent {
            delay: ms(40),
            payload: json!({
                "type": "turn_start",
                "turnIndex": 1,
            }),
        },

        // ── user message (start → end) ──
        MockEvent {
            delay: ms(40),
            payload: json!({
                "type": "message_start",
                "message": {
                    "id": "test-user-1",
                    "role": "user",
                    "content": [{ "type": "text", "text": "Run all event types for comprehensive testing." }],
                },
            }),
        },
        MockEvent {
            delay: ms(30),
            payload: json!({
                "type": "message_end",
                "message": {
                    "id": "test-user-1",
                    "role": "user",
                    "content": [{ "type": "text", "text": "Run all event types for comprehensive testing." }],
                },
            }),
        },

        // ── assistant message start ──
        MockEvent {
            delay: ms(50),
            payload: json!({
                "type": "message_start",
                "message": {
                    "id": "test-assistant-1",
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "I'll run through every event type now. Starting with tool calls..." }],
                },
            }),
        },

        // ── extension_ui_request: setTitle ──
        MockEvent {
            delay: ms(40),
            payload: json!({
                "type": "extension_ui_request",
                "method": "setTitle",
                "title": "Comprehensive Test Run",
            }),
        },

        // ── extension_ui_request: notify ──
        MockEvent {
            delay: ms(40),
            payload: json!({
                "type": "extension_ui_request",
                "method": "notify",
                "message": "Test phase 1: tool execution with success and failure cases.",
            }),
        },

        // ── extension_ui_request: setWidget ──
        MockEvent {
            delay: ms(40),
            payload: json!({
                "type": "extension_ui_request",
                "method": "setWidget",
                "widgetLines": [
                    "Test Dashboard",
                    "Phase: 1/5 - Tool Execution",
                    "Events emitted: 8",
                    "Status: running"
                ],
            }),
        },

        // ── tool_execution_start + end (SUCCESS — read file) ──
        MockEvent {
            delay: ms(50),
            payload: json!({
                "type": "tool_execution_start",
                "command": "read_file",
                "arguments": {
                    "path": "src/main.rs",
                    "purpose": "inspect entry point"
                },
            }),
        },
        MockEvent {
            delay: ms(80),
            payload: json!({
                "type": "tool_execution_end",
                "command": "read_file",
                "success": true,
                "summary": "Read 142 lines from src/main.rs — entry point with CLI arg parsing",
                "contextPercent": 12,
            }),
        },

        // ── tool_execution_start + end (SUCCESS — grep) ──
        MockEvent {
            delay: ms(50),
            payload: json!({
                "type": "tool_execution_start",
                "command": "grep_search",
                "arguments": {
                    "pattern": "WebSocket",
                    "path": "src/web/"
                },
            }),
        },
        MockEvent {
            delay: ms(70),
            payload: json!({
                "type": "tool_execution_end",
                "command": "grep_search",
                "success": true,
                "summary": "Found 14 matches across 3 files in src/web/",
                "contextPercent": 18,
            }),
        },

        // ── tool_execution_start + end (FAILURE — write denied) ──
        MockEvent {
            delay: ms(50),
            payload: json!({
                "type": "tool_execution_start",
                "command": "write_file",
                "arguments": {
                    "path": "/etc/readonly-config.toml",
                    "purpose": "attempt write to read-only location"
                },
            }),
        },
        MockEvent {
            delay: ms(60),
            payload: json!({
                "type": "tool_execution_end",
                "command": "write_file",
                "success": false,
                "summary": "Permission denied: cannot write to /etc/readonly-config.toml",
                "error": "EACCES: permission denied, open '/etc/readonly-config.toml'",
                "contextPercent": 20,
            }),
        },

        // ── tool_execution_start + end (SUCCESS — run command) ──
        MockEvent {
            delay: ms(50),
            payload: json!({
                "type": "tool_execution_start",
                "command": "run_command",
                "arguments": {
                    "command": "cargo check",
                    "package": "bindery"
                },
            }),
        },
        MockEvent {
            delay: ms(100),
            payload: json!({
                "type": "tool_execution_end",
                "command": "run_command",
                "success": true,
                "summary": "cargo check completed successfully (0 warnings, 0 errors)",
                "contextPercent": 25,
            }),
        },

        // ── message_update (mid-stream progress) ──
        MockEvent {
            delay: ms(60),
            payload: json!({
                "type": "message_update",
                "message": {
                    "id": "test-assistant-1",
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "Tool execution phase complete. 3 succeeded, 1 failed (expected). Moving to context threshold tests..." }],
                },
            }),
        },

        // ── extension_ui_request: setWidget (phase 2) ──
        MockEvent {
            delay: ms(40),
            payload: json!({
                "type": "extension_ui_request",
                "method": "setWidget",
                "widgetLines": [
                    "Test Dashboard",
                    "Phase: 2/5 - Context Thresholds",
                    "Events emitted: 18",
                    "Status: running"
                ],
            }),
        },

        // ── context at 45% ──
        MockEvent {
            delay: ms(50),
            payload: json!({
                "type": "tool_execution_start",
                "command": "read_file",
                "arguments": {
                    "path": "Cargo.lock",
                    "purpose": "load large dependency tree"
                },
            }),
        },
        MockEvent {
            delay: ms(60),
            payload: json!({
                "type": "tool_execution_end",
                "command": "read_file",
                "success": true,
                "summary": "Read 2847 lines from Cargo.lock",
                "contextPercent": 45,
            }),
        },

        // ── context at 75% (warning threshold) ──
        MockEvent {
            delay: ms(50),
            payload: json!({
                "type": "tool_execution_start",
                "command": "read_file",
                "arguments": {
                    "path": "target/debug/deps/analysis.d",
                    "purpose": "load compiler dependency graph"
                },
            }),
        },
        MockEvent {
            delay: ms(60),
            payload: json!({
                "type": "tool_execution_end",
                "command": "read_file",
                "success": true,
                "summary": "Read 4200 lines from dependency graph",
                "contextPercent": 75,
            }),
        },

        // ── extension_ui_request: notify (warning) ──
        MockEvent {
            delay: ms(40),
            payload: json!({
                "type": "extension_ui_request",
                "method": "notify",
                "message": "Context usage at 75%. Consider compacting conversation history.",
            }),
        },

        // ── context at 92% (critical threshold) ──
        MockEvent {
            delay: ms(50),
            payload: json!({
                "type": "tool_execution_start",
                "command": "read_file",
                "arguments": {
                    "path": "node_modules/.package-lock.json",
                    "purpose": "stress-test context window"
                },
            }),
        },
        MockEvent {
            delay: ms(60),
            payload: json!({
                "type": "tool_execution_end",
                "command": "read_file",
                "success": true,
                "summary": "Context near capacity after reading package lock",
                "contextPercent": 92,
            }),
        },

        // ── extension_ui_request: notify (critical) ──
        MockEvent {
            delay: ms(40),
            payload: json!({
                "type": "extension_ui_request",
                "method": "notify",
                "message": "CRITICAL: Context usage at 92%. Automatic compaction will trigger soon.",
            }),
        },

        // ── message_update (progress) ──
        MockEvent {
            delay: ms(50),
            payload: json!({
                "type": "message_update",
                "message": {
                    "id": "test-assistant-1",
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "Context thresholds tested at 45%, 75%, and 92%. The UI should show meter color changes. Now testing model selection..." }],
                },
            }),
        },

        // ── model_select ──
        MockEvent {
            delay: ms(40),
            payload: json!({
                "type": "model_select",
                "model": { "provider": "anthropic", "id": "claude-sonnet-4-20250514" },
            }),
        },

        // ── extension_ui_request: setWidget (phase 3) ──
        MockEvent {
            delay: ms(40),
            payload: json!({
                "type": "extension_ui_request",
                "method": "setWidget",
                "widgetLines": [
                    "Test Dashboard",
                    "Phase: 3/5 - Multi-tool Parallel",
                    "Events emitted: 30",
                    "Status: running"
                ],
            }),
        },

        // ── Parallel tool calls (two starts, then two ends) ──
        MockEvent {
            delay: ms(40),
            payload: json!({
                "type": "tool_execution_start",
                "command": "read_file",
                "arguments": {
                    "path": "src/config.rs",
                    "purpose": "check config structure"
                },
            }),
        },
        MockEvent {
            delay: ms(20),
            payload: json!({
                "type": "tool_execution_start",
                "command": "grep_search",
                "arguments": {
                    "pattern": "impl AppConfig",
                    "path": "src/"
                },
            }),
        },
        MockEvent {
            delay: ms(80),
            payload: json!({
                "type": "tool_execution_end",
                "command": "grep_search",
                "success": true,
                "summary": "Found AppConfig impl in src/config.rs:48",
                "contextPercent": 55,
            }),
        },
        MockEvent {
            delay: ms(40),
            payload: json!({
                "type": "tool_execution_end",
                "command": "read_file",
                "success": true,
                "summary": "Read 62 lines from src/config.rs — AppConfig with env expansion",
                "contextPercent": 58,
            }),
        },

        // ── Task session lifecycle ──
        MockEvent {
            delay: ms(40),
            payload: json!({
                "type": "extension_ui_request",
                "method": "setWidget",
                "widgetLines": [
                    "Test Dashboard",
                    "Phase: 4/5 - Task Session Lifecycle",
                    "Events emitted: 36",
                    "Status: running"
                ],
            }),
        },

        MockEvent {
            delay: ms(40),
            payload: json!({
                "type": "extension_ui_request",
                "method": "notify",
                "message": "Simulating task session: start → work → complete cycle.",
            }),
        },

        // ── Second assistant message (multi-turn demonstration) ──
        MockEvent {
            delay: ms(50),
            payload: json!({
                "type": "message_start",
                "message": {
                    "id": "test-assistant-2",
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "This is a second assistant message in the same turn, demonstrating multi-message support within a single agent loop." }],
                },
            }),
        },
        MockEvent {
            delay: ms(60),
            payload: json!({
                "type": "message_end",
                "message": {
                    "id": "test-assistant-2",
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "This is a second assistant message in the same turn, demonstrating multi-message support within a single agent loop." }],
                },
                "usage": { "inputTokens": 420, "outputTokens": 38 },
                "contextPercent": 60,
            }),
        },

        // ── Final token-heavy message ──
        MockEvent {
            delay: ms(40),
            payload: json!({
                "type": "extension_ui_request",
                "method": "setWidget",
                "widgetLines": [
                    "Test Dashboard",
                    "Phase: 5/5 - Final Summary",
                    "Events emitted: 42",
                    "Status: completing"
                ],
            }),
        },

        // ── Final assistant message_end with large token usage ──
        MockEvent {
            delay: ms(80),
            payload: json!({
                "type": "message_end",
                "message": {
                    "id": "test-assistant-1",
                    "role": "assistant",
                    "content": [{
                        "type": "text",
                        "text": "Comprehensive test complete.\n\nEvent coverage summary:\n- agent_start / agent_end\n- turn_start / turn_end\n- message_start / message_update / message_end (user + assistant)\n- tool_execution_start / tool_execution_end (success + failure)\n- extension_ui_request: setTitle, notify, setWidget\n- model_select\n- Context thresholds: 5% → 12% → 18% → 25% → 45% → 75% → 92% → 60%\n- Parallel tool execution (2 concurrent)\n- Multi-message assistant responses\n- Token accumulation across events\n\nAll event types exercised. The UI should display:\n- Correct event stream rows with proper colors and badges\n- Working flame chart showing event timing\n- Context meter color changes (purple → amber → red → purple)\n- Token accumulation in status panel\n- Tool count incrementing\n- Model tag updating to claude-sonnet-4-20250514\n- Session title updating to 'Comprehensive Test Run'"
                    }],
                },
                "usage": { "inputTokens": 1842, "outputTokens": 356 },
                "contextPercent": 48,
            }),
        },

        // ── Model back to original ──
        MockEvent {
            delay: ms(40),
            payload: json!({
                "type": "model_select",
                "model": model.clone(),
            }),
        },

        // ── turn_end ──
        MockEvent {
            delay: ms(40),
            payload: json!({
                "type": "turn_end",
                "turnIndex": 1,
            }),
        },

        // ── agent_end ──
        MockEvent {
            delay: ms(40),
            payload: json!({
                "type": "agent_end",
                "agentId": "test-agent",
                "label": "comprehensive-test-run",
                "contextPercent": 48,
            }),
        },
    ]
}

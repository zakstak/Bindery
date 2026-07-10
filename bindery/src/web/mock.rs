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
    child_session_file: String,
}

fn current_model_label(model: &Value) -> String {
    let provider = model
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("mock");
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
        .route("/api/mock/inspect/{agent_id}", get(inspect_handler))
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
    let mut session_file = String::from("/tmp/mock-parent.jsonl");
    let mut fork_messages: Vec<Value> = vec![
        json!({ "entryId": "mock-entry-1", "text": "Ship a launch page this week with QA and release notes." }),
        json!({ "entryId": "mock-entry-2", "text": "Stabilize onboarding before Friday and prepare a rollout brief." }),
    ];
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
                            "sessionFile": session_file,
                            "sessionId": "mock-session",
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

                if !user_prompt.is_empty() {
                    fork_messages.push(json!({
                        "entryId": format!("mock-entry-{}", prompt_index.saturating_add(2)),
                        "text": user_prompt,
                    }));
                    if fork_messages.len() > 24 {
                        fork_messages.remove(0);
                    }
                }

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
                    build_prompt_sequence(prompt_index, &user_prompt, &prompt_images, &model),
                )
                .await
                {
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
                let previous_session_file = session_file.clone();
                let next_session_file = format!("/tmp/mock-task-{task_index}.jsonl");
                session_name = format!("Task · {goal}");
                session_file = next_session_file.clone();
                active_task = Some(MockTaskState {
                    task_id: task_id.clone(),
                    goal: goal.clone(),
                    completed: false,
                    child_session_file: next_session_file.clone(),
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
                                "parentSessionFile": previous_session_file.clone(),
                                "cwd": "/tmp/mock-project",
                                "model": current_model_label(&model),
                                "goal": goal,
                                "constraints": command.get("constraints").cloned().unwrap_or_else(|| json!([])),
                                "relevantFiles": [],
                                "doneDefinition": command.get("doneDefinition").or_else(|| command.get("done_definition")).and_then(Value::as_str).unwrap_or("Return one structured result summary with changed files, open risks, and the next recommended step."),
                                "notes": command.get("notes").cloned().unwrap_or(Value::Null),
                            },
                            "previousSessionFile": previous_session_file,
                            "nextSessionFile": next_session_file.clone(),
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
                let parent_session_file = String::from("/tmp/mock-parent.jsonl");
                let child_session_file = task_state.child_session_file.clone();

                if resume_parent {
                    session_name = String::from("Bindery demo session");
                    session_file = parent_session_file.clone();
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
                                "childSessionFile": child_session_file,
                                "parentSessionFile": parent_session_file.clone(),
                                "model": current_model_label(&model),
                                "summary": summary,
                                "changedFiles": [],
                                "openRisks": command.get("openRisks").or_else(|| command.get("open_risks")).cloned().unwrap_or_else(|| json!([])),
                                "nextStep": command.get("nextStep").or_else(|| command.get("next_step")).and_then(Value::as_str).unwrap_or("Return to the parent session and continue from this result."),
                                "notes": command.get("notes").cloned().unwrap_or(Value::Null),
                            },
                            "resumedParent": resume_parent,
                            "parentSessionFile": parent_session_file,
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
            "get_available_models" => {
                if send_json(
                    &mut socket,
                    json!({
                        "type": "response",
                        "command": "get_available_models",
                        "success": true,
                        "data": {
                            "models": [
                                {
                                    "provider": "mock",
                                    "id": "bindery-demo-orchestrator-v2",
                                    "name": "Mock Orchestrator",
                                },
                                {
                                    "provider": "mock",
                                    "id": "bindery-demo-release-ops-v1",
                                    "name": "Mock Release Ops",
                                },
                                {
                                    "provider": "mock",
                                    "id": "bindery-demo-research-v1",
                                    "name": "Mock Research",
                                }
                            ]
                        }
                    }),
                )
                .await
                .is_err()
                {
                    return;
                }
            }
            "switch_session" => {
                let session_path = command
                    .get("sessionPath")
                    .or_else(|| command.get("session_path"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string();

                if session_path.is_empty() {
                    if send_json(
                        &mut socket,
                        json!({
                            "type": "response",
                            "command": "switch_session",
                            "success": false,
                            "error": "sessionPath is required",
                        }),
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                    continue;
                }

                session_file = session_path.clone();
                let leaf = session_path
                    .split('/')
                    .filter(|part| !part.is_empty())
                    .next_back()
                    .unwrap_or("session");
                session_name = format!("Session · {leaf}");

                if send_json(
                    &mut socket,
                    json!({
                        "type": "response",
                        "command": "switch_session",
                        "success": true,
                        "data": { "cancelled": false },
                    }),
                )
                .await
                .is_err()
                {
                    return;
                }
            }
            "get_fork_messages" => {
                if send_json(
                    &mut socket,
                    json!({
                        "type": "response",
                        "command": "get_fork_messages",
                        "success": true,
                        "data": {
                            "messages": fork_messages.clone(),
                        }
                    }),
                )
                .await
                .is_err()
                {
                    return;
                }
            }
            "fork" => {
                let entry_id = command
                    .get("entryId")
                    .or_else(|| command.get("entry_id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string();

                if entry_id.is_empty() {
                    if send_json(
                        &mut socket,
                        json!({
                            "type": "response",
                            "command": "fork",
                            "success": false,
                            "error": "entryId is required",
                        }),
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                    continue;
                }

                let selected_text = fork_messages
                    .iter()
                    .find(|entry| {
                        entry
                            .get("entryId")
                            .and_then(Value::as_str)
                            .map(|value| value == entry_id.as_str())
                            .unwrap_or(false)
                    })
                    .and_then(|entry| entry.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();

                if selected_text.is_empty() {
                    if send_json(
                        &mut socket,
                        json!({
                            "type": "response",
                            "command": "fork",
                            "success": false,
                            "error": "fork entry not found",
                        }),
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                    continue;
                }

                session_file = format!("/tmp/mock-fork-{entry_id}.jsonl");
                session_name = format!("Fork · {entry_id}");

                if send_json(
                    &mut socket,
                    json!({
                        "type": "response",
                        "command": "fork",
                        "success": true,
                        "data": {
                            "text": selected_text,
                            "cancelled": false,
                        }
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
    socket
        .send(Message::Text(text.into()))
        .await
        .map_err(|_| ())
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

fn build_prompt_sequence(
    prompt_index: u32,
    prompt: &str,
    images: &[Value],
    model: &Value,
) -> Vec<MockEvent> {
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

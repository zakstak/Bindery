use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use serde_json::{json, Value};
use tracing::{info, warn};

use crate::{rpc::client::RpcClient, rpc::RpcCommand, AppConfig};

fn message_preview(event: &Value) -> Option<String> {
    let message = event.get("message")?.as_object()?;
    let content = message.get("content")?.as_array()?;
    let mut parts = Vec::new();
    let mut image_count = 0;
    for block in content {
        if let Some(text) = block.get("text").and_then(Value::as_str) {
            if !text.trim().is_empty() {
                parts.push(text.trim().to_string());
            }
        } else if block.get("type").and_then(Value::as_str) == Some("input_text") {
            if let Some(text) = block.get("text").and_then(Value::as_str) {
                if !text.trim().is_empty() {
                    parts.push(text.trim().to_string());
                }
            }
        } else if matches!(
            block.get("type").and_then(Value::as_str),
            Some("image") | Some("input_image")
        ) || block.get("image").is_some()
        {
            image_count += 1;
        }
    }
    if !parts.is_empty() {
        Some(parts.join(" "))
    } else if image_count > 0 {
        Some(format!(
            "{image_count} image attachment{}",
            if image_count == 1 { "" } else { "s" }
        ))
    } else {
        None
    }
}

fn arguments_preview(arguments: &Value) -> Option<String> {
    let object = arguments.as_object()?;
    for key in ["path", "pattern", "purpose", "focus", "package"] {
        if let Some(value) = object.get(key).and_then(Value::as_str) {
            if !value.trim().is_empty() {
                return Some(format!("{key}: {value}"));
            }
        }
    }
    None
}

fn model_label(model: &Value) -> Option<String> {
    let provider = model.get("provider").and_then(Value::as_str);
    let id = model
        .get("id")
        .or_else(|| model.get("modelId"))
        .and_then(Value::as_str);
    match (provider, id) {
        (Some(provider), Some(id)) => Some(format!("{provider}/{id}")),
        (None, Some(id)) => Some(id.to_string()),
        _ => None,
    }
}

fn compact_preview(value: &str, max_len: usize) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.chars().count() <= max_len {
        return trimmed.to_string();
    }
    trimmed
        .chars()
        .take(max_len.saturating_sub(1))
        .collect::<String>()
        + "…"
}

fn bindery_meta_for(event: &Value) -> Option<Value> {
    let event_type = event.get("type").and_then(Value::as_str)?;
    match event_type {
        "response" => {
            let command = event
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let success = event
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let preview = if success {
                if let Some(data) = event.get("data") {
                    if command == "get_state" {
                        let session = data
                            .get("sessionName")
                            .and_then(Value::as_str)
                            .unwrap_or("session ready");
                        let model = data
                            .get("model")
                            .and_then(model_label)
                            .unwrap_or_else(|| "state updated".to_string());
                        format!("{session} · {model}")
                    } else if command == "set_model" {
                        data.get("id")
                            .or_else(|| data.get("modelId"))
                            .and_then(Value::as_str)
                            .map(|id| format!("model set to {id}"))
                            .unwrap_or_else(|| format!("{command} ok"))
                    } else if command == "start_task_session" {
                        data.get("packet")
                            .and_then(|value| value.get("goal"))
                            .and_then(Value::as_str)
                            .map(|value| compact_preview(value, 40))
                            .filter(|value| !value.is_empty())
                            .map(|value| format!("task started · {value}"))
                            .unwrap_or_else(|| format!("{command} ok"))
                    } else if command == "complete_task_session" {
                        let prefix = if data
                            .get("resumedParent")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                        {
                            "parent resumed"
                        } else {
                            "task completed"
                        };
                        data.get("result")
                            .and_then(|value| value.get("summary"))
                            .and_then(Value::as_str)
                            .map(|value| compact_preview(value, 40))
                            .filter(|value| !value.is_empty())
                            .map(|value| format!("{prefix} · {value}"))
                            .unwrap_or_else(|| prefix.to_string())
                    } else if command == "switch_session" {
                        if data
                            .get("cancelled")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                        {
                            "session switch cancelled".to_string()
                        } else {
                            "session switched".to_string()
                        }
                    } else if command == "fork" {
                        let prefix = if data
                            .get("cancelled")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                        {
                            "fork cancelled"
                        } else {
                            "fork created"
                        };
                        data.get("text")
                            .and_then(Value::as_str)
                            .map(|value| compact_preview(value, 40))
                            .filter(|value| !value.is_empty())
                            .map(|value| format!("{prefix} · {value}"))
                            .unwrap_or_else(|| prefix.to_string())
                    } else if command == "get_available_models" {
                        let count = data
                            .get("models")
                            .and_then(Value::as_array)
                            .map_or(0, |models| models.len());
                        format!(
                            "{count} model{} available",
                            if count == 1 { "" } else { "s" }
                        )
                    } else if command == "get_fork_messages" {
                        let count = data
                            .get("messages")
                            .and_then(Value::as_array)
                            .map_or(0, |messages| messages.len());
                        format!(
                            "{count} fork point{} available",
                            if count == 1 { "" } else { "s" }
                        )
                    } else {
                        format!("{command} ok")
                    }
                } else {
                    format!("{command} ok")
                }
            } else {
                event
                    .get("error")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .unwrap_or_else(|| format!("{command} failed"))
            };
            Some(json!({
                "kind": "response",
                "title": format!("response {command}"),
                "preview": preview,
            }))
        }
        "extension_ui_request" => {
            let method = event.get("method").and_then(Value::as_str).unwrap_or("ui");
            let preview = event
                .get("message")
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .or_else(|| {
                    event
                        .get("title")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                })
                .or_else(|| {
                    event
                        .get("widgetLines")
                        .and_then(Value::as_array)
                        .and_then(|lines| lines.first())
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                })
                .unwrap_or_else(|| format!("ui method: {method}"));
            Some(json!({
                "kind": "ui",
                "title": format!("ui {method}"),
                "preview": preview,
            }))
        }
        "tool_execution_start" | "tool_execution_end" => {
            let command = event
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or("tool");
            let phase = if event_type.ends_with("start") {
                "start"
            } else if event.get("success").and_then(Value::as_bool) == Some(false) {
                "failed"
            } else {
                "done"
            };
            let preview = event
                .get("summary")
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .or_else(|| event.get("arguments").and_then(arguments_preview))
                .unwrap_or_else(|| format!("command: {command}"));
            Some(json!({
                "kind": "tool",
                "title": format!("tool {command} {phase}"),
                "preview": preview,
            }))
        }
        "message_start" | "message_update" | "message_end" => {
            let role = event
                .get("message")
                .and_then(|message| message.get("role"))
                .and_then(Value::as_str)
                .unwrap_or("event");
            let preview = message_preview(event).unwrap_or_else(|| format!("{role} message"));
            let title = match role {
                "assistant" => "assistant response",
                "user" => "user request",
                _ => "message",
            };
            Some(json!({
                "kind": role,
                "title": title,
                "preview": preview,
            }))
        }
        "agent_start" | "agent_end" => {
            let label = event
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or("agent");
            Some(json!({
                "kind": "agent",
                "title": if event_type.ends_with("start") { "agent start" } else { "agent end" },
                "preview": label,
            }))
        }
        "turn_start" | "turn_end" => {
            let turn_index = event.get("turnIndex").and_then(Value::as_u64).unwrap_or(0);
            Some(json!({
                "kind": "agent",
                "title": format!("turn {turn_index} {}", if event_type.ends_with("start") { "start" } else { "end" }),
                "preview": format!("turn {turn_index}"),
            }))
        }
        "model_select" => Some(json!({
            "kind": "agent",
            "title": "model selected",
            "preview": event.get("model").and_then(model_label).unwrap_or_else(|| "model updated".to_string()),
        })),
        _ => None,
    }
}

fn with_bindery_meta(mut event: Value) -> Value {
    if event.get("binderyMeta").is_some() {
        return event;
    }
    let Some(meta) = bindery_meta_for(&event) else {
        return event;
    };
    if let Some(object) = event.as_object_mut() {
        object.insert("binderyMeta".to_string(), meta);
    }
    event
}

fn extract_command_name(command: &Value) -> String {
    command
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string()
}

fn extract_command_id(command: &Value) -> Option<String> {
    command
        .get("id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn response_error(id: Option<String>, command: &str, error: String) -> Value {
    let mut payload = serde_json::Map::new();
    payload.insert("type".to_string(), json!("response"));
    payload.insert("command".to_string(), json!(command));
    payload.insert("success".to_string(), json!(false));
    payload.insert("error".to_string(), json!(error));
    if let Some(id) = id {
        payload.insert("id".to_string(), json!(id));
    }
    Value::Object(payload)
}

async fn send_json(socket: &mut WebSocket, payload: Value) -> bool {
    let text = match serde_json::to_string(&payload) {
        Ok(text) => text,
        Err(error) => {
            warn!("failed to serialize websocket payload: {error}");
            return false;
        }
    };
    socket.send(Message::Text(text.into())).await.is_ok()
}

pub fn router(config: AppConfig) -> Router {
    Router::new()
        .route("/ws", get(ws_handler))
        .with_state(config)
}

async fn ws_handler(ws: WebSocketUpgrade, State(config): State<AppConfig>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, config))
}

async fn handle_socket(mut socket: WebSocket, config: AppConfig) {
    info!("WebSocket connection opened — spawning agent");

    let mut client = match RpcClient::spawn(
        &config.agent.cli_path,
        &config.agent.cwd,
        &config.agent.env,
    )
    .await
    {
        Ok(c) => c,
        Err(e) => {
            warn!("failed to spawn agent: {e}");
            let _ = socket
                .send(Message::Text(
                    format!(r#"{{"type":"error","message":"failed to spawn agent: {e}"}}"#).into(),
                ))
                .await;
            return;
        }
    };

    if let Some(ref dm) = config.agent.default_model {
        let command = RpcCommand::SetModel {
            id: None,
            provider: dm.provider.clone(),
            model_id: dm.model_id.clone(),
        };
        if let Err(e) = client.send(&command).await {
            warn!("failed to send set_model: {e}");
        }
    }

    loop {
        tokio::select! {
            // Browser → agent: forward commands
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<Value>(&text) {
                            Ok(raw_command) => {
                                let command_name = extract_command_name(&raw_command);
                                let command_id = extract_command_id(&raw_command);
                                let raw_command_for_agent = raw_command.clone();
                                match serde_json::from_value::<RpcCommand>(raw_command) {
                                    Ok(cmd) => {
                                        let send_result = match &cmd {
                                            RpcCommand::ExtensionUiResponse { .. } => {
                                                client.send_raw(raw_command_for_agent).await
                                            }
                                            _ => client.send(&cmd).await,
                                        };
                                        if let Err(e) = send_result {
                                            warn!("failed to send command to agent: {e}");
                                            break;
                                        }
                                    }
                                    Err(e) => {
                                        warn!("invalid command payload from browser: {e} — {text}");
                                        let payload = response_error(
                                            command_id,
                                            &command_name,
                                            format!("Invalid command payload: {e}"),
                                        );
                                        if !send_json(&mut socket, payload).await {
                                            info!("WebSocket send failed — client disconnected");
                                            break;
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                warn!("invalid command json from browser: {e} — {text}");
                                let payload = response_error(
                                    None,
                                    "parse",
                                    format!("Failed to parse command: {e}"),
                                );
                                if !send_json(&mut socket, payload).await {
                                    info!("WebSocket send failed — client disconnected");
                                    break;
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        info!("WebSocket closed by browser");
                        break;
                    }
                    _ => {}
                }
            }

            // Agent → browser: forward events
            event = client.events.recv() => {
                match event {
                    Some(ev) => {
                        let ev = with_bindery_meta(ev);
                        let text = match serde_json::to_string(&ev) {
                            Ok(t) => t,
                            Err(e) => { warn!("failed to serialize event: {e}"); continue; }
                        };
                        if socket.send(Message::Text(text.into())).await.is_err() {
                            info!("WebSocket send failed — client disconnected");
                            break;
                        }
                    }
                    None => {
                        info!("agent stdout closed");
                        break;
                    }
                }
            }
        }
    }
}

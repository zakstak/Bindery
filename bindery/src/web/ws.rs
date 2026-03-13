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
    for block in content {
        if let Some(text) = block.get("text").and_then(Value::as_str) {
            if !text.trim().is_empty() {
                parts.push(text.trim().to_string());
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" "))
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

fn bindery_meta_for(event: &Value) -> Option<Value> {
    let event_type = event.get("type").and_then(Value::as_str)?;
    match event_type {
        "response" => {
            let command = event.get("command").and_then(Value::as_str).unwrap_or("unknown");
            let success = event.get("success").and_then(Value::as_bool).unwrap_or(false);
            let preview = if success {
                if let Some(data) = event.get("data") {
                    if command == "get_state" {
                        let session = data.get("sessionName").and_then(Value::as_str).unwrap_or("session ready");
                        let model = data.get("model").and_then(model_label).unwrap_or_else(|| "state updated".to_string());
                        format!("{session} · {model}")
                    } else if command == "set_model" {
                        data.get("id")
                            .or_else(|| data.get("modelId"))
                            .and_then(Value::as_str)
                            .map(|id| format!("model set to {id}"))
                            .unwrap_or_else(|| format!("{command} ok"))
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
                .or_else(|| event.get("title").and_then(Value::as_str).map(ToString::to_string))
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
            let command = event.get("command").and_then(Value::as_str).unwrap_or("tool");
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
            let label = event.get("label").and_then(Value::as_str).unwrap_or("agent");
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

pub fn router(config: AppConfig) -> Router {
    Router::new()
        .route("/ws", get(ws_handler))
        .with_state(config)
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(config): State<AppConfig>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, config))
}

async fn handle_socket(mut socket: WebSocket, config: AppConfig) {
    info!("WebSocket connection opened — spawning agent");

    let mut client = match RpcClient::spawn(&config.agent.cli_path, &config.agent.cwd, &config.agent.env).await {
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

    // Auto-select the default model immediately after spawn.
    // NOTE: Send as raw JSON — the pi RPC protocol uses camelCase (modelId),
    // but RpcCommand's rename_all = "snake_case" would produce model_id.
    if let Some(ref dm) = config.agent.default_model {
        let raw = serde_json::json!({
            "type": "set_model",
            "provider": dm.provider,
            "modelId": dm.model_id,
        });
        if let Err(e) = client.send_raw(raw).await {
            warn!("failed to send set_model: {e}");
        }
    }

    loop {
        tokio::select! {
            // Browser → agent: forward commands
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<RpcCommand>(&text) {
                            Ok(cmd) => {
                                if let Err(e) = client.send(&cmd).await {
                                    warn!("failed to send command to agent: {e}");
                                    break;
                                }
                            }
                            Err(e) => {
                                warn!("invalid command from browser: {e} — {text}");
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

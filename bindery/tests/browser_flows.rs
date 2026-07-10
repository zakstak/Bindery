use std::{collections::HashMap, time::Duration};

use anyhow::{bail, Context, Result};
use bindery::{
    config::{AgentConfig, AppConfig, DefaultModel, ServerConfig},
    serve,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

type TestSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

fn test_config() -> AppConfig {
    AppConfig {
        server: ServerConfig {
            bind_address: "127.0.0.1:0".parse().expect("valid bind address"),
        },
        agent: AgentConfig {
            cli_path: "/bin/true".to_string(),
            cwd: std::env::current_dir()
                .expect("current dir")
                .display()
                .to_string(),
            env: HashMap::new(),
            default_model: Some(DefaultModel {
                provider: "mock".to_string(),
                model_id: "bindery-demo-orchestrator-v2".to_string(),
            }),
        },
        diffy: None,
    }
}

async fn next_json(socket: &mut TestSocket) -> Result<Value> {
    loop {
        let message = timeout(Duration::from_secs(5), socket.next())
            .await
            .context("timed out waiting for websocket message")?
            .transpose()
            .context("websocket receive error")?
            .context("websocket closed unexpectedly")?;

        match message {
            Message::Text(text) => {
                return serde_json::from_str(text.as_ref())
                    .context("failed to parse websocket json")
            }
            Message::Ping(payload) => {
                socket
                    .send(Message::Pong(payload))
                    .await
                    .context("failed to answer ping")?;
            }
            Message::Pong(_) | Message::Binary(_) | Message::Frame(_) => {}
            Message::Close(frame) => bail!("websocket closed unexpectedly: {frame:?}"),
        }
    }
}

async fn wait_for_response(socket: &mut TestSocket, command: &str) -> Result<Value> {
    for _ in 0..64 {
        let payload = next_json(socket).await?;
        if payload.get("type").and_then(Value::as_str) == Some("response")
            && payload.get("command").and_then(Value::as_str) == Some(command)
        {
            return Ok(payload);
        }
    }

    bail!("missing response for command {command}")
}

async fn wait_for_event(socket: &mut TestSocket, event_type: &str) -> Result<Value> {
    for _ in 0..96 {
        let payload = next_json(socket).await?;
        if payload.get("type").and_then(Value::as_str) == Some(event_type) {
            return Ok(payload);
        }
    }

    bail!("missing event {event_type}")
}

#[tokio::test]
async fn renders_root_and_mock_shell_controls() -> Result<()> {
    let server = serve(test_config()).await?;
    let base_url = format!("http://{}", server.local_addr);
    let client = reqwest::Client::new();

    let root_html = client
        .get(format!("{base_url}/"))
        .send()
        .await
        .context("failed to load root shell")?
        .error_for_status()
        .context("root shell returned error")?
        .text()
        .await
        .context("failed to read root shell body")?;

    let mock_html = client
        .get(format!("{base_url}/mock"))
        .send()
        .await
        .context("failed to load mock shell")?
        .error_for_status()
        .context("mock shell returned error")?
        .text()
        .await
        .context("failed to read mock shell body")?;

    server.stop().await?;

    assert!(root_html.contains("id=\"btn-model-picker\""));
    assert!(root_html.contains("id=\"btn-session-picker\""));
    assert!(root_html.contains("id=\"prompt-form\""));
    assert!(root_html.contains("const SOCKET_PATH = IS_MOCK_ROUTE ? '/ws/mock' : '/ws';"));
    assert!(mock_html.contains("Mock presets"));
    assert!(mock_html.contains("Task start"));
    assert!(mock_html.contains("Task done"));

    Ok(())
}

#[tokio::test]
async fn mock_websocket_preserves_browser_operator_flows() -> Result<()> {
    let server = serve(test_config()).await?;
    let ws_url = format!("ws://{}/ws/mock", server.local_addr);
    let (mut socket, _) = connect_async(ws_url)
        .await
        .context("failed to connect to mock websocket")?;

    socket
        .send(Message::Text(
            json!({ "type": "get_state" }).to_string().into(),
        ))
        .await
        .context("failed to request state")?;
    let state_response = wait_for_response(&mut socket, "get_state").await?;
    assert_eq!(state_response["success"], Value::Bool(true));
    assert_eq!(
        state_response["data"]["sessionName"],
        Value::String("Bindery demo session".to_string())
    );
    assert_eq!(
        state_response["data"]["model"]["id"],
        Value::String("bindery-demo-orchestrator-v2".to_string())
    );

    let boot_ui = wait_for_event(&mut socket, "extension_ui_request").await?;
    assert_eq!(boot_ui["method"], Value::String("setTitle".to_string()));
    let boot_message = wait_for_event(&mut socket, "message_end").await?;
    assert_eq!(
        boot_message["message"]["role"],
        Value::String("assistant".to_string())
    );

    socket
        .send(Message::Text(
            json!({ "type": "get_available_models" }).to_string().into(),
        ))
        .await
        .context("failed to request model list")?;
    let models_response = wait_for_response(&mut socket, "get_available_models").await?;
    assert_eq!(models_response["success"], Value::Bool(true));
    assert_eq!(
        models_response["data"]["models"]
            .as_array()
            .map(|models| models.len()),
        Some(3)
    );

    socket
        .send(Message::Text(
            json!({
                "type": "set_model",
                "provider": "mock",
                "modelId": "bindery-demo-release-ops-v1"
            })
            .to_string()
            .into(),
        ))
        .await
        .context("failed to set model")?;
    let set_model_response = wait_for_response(&mut socket, "set_model").await?;
    assert_eq!(set_model_response["success"], Value::Bool(true));
    assert_eq!(
        set_model_response["data"]["id"],
        Value::String("bindery-demo-release-ops-v1".to_string())
    );

    socket
        .send(Message::Text(
            json!({ "type": "prompt", "message": "Ship the launch page this week" })
                .to_string()
                .into(),
        ))
        .await
        .context("failed to send prompt")?;
    let prompt_response = wait_for_response(&mut socket, "prompt").await?;
    assert_eq!(prompt_response["success"], Value::Bool(true));
    assert_eq!(prompt_response["data"]["accepted"], Value::Bool(true));

    let prompt_tool = wait_for_event(&mut socket, "tool_execution_start").await?;
    assert_eq!(prompt_tool["command"], Value::String("read".to_string()));
    let prompt_summary = wait_for_event(&mut socket, "message_end").await?;
    assert_eq!(
        prompt_summary["message"]["role"],
        Value::String("assistant".to_string())
    );
    assert!(prompt_summary["message"]["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .contains("Launch brief ready"));

    socket
        .send(Message::Text(
            json!({ "type": "get_fork_messages" }).to_string().into(),
        ))
        .await
        .context("failed to request fork messages")?;
    let fork_messages_response = wait_for_response(&mut socket, "get_fork_messages").await?;
    let fork_messages = fork_messages_response["data"]["messages"]
        .as_array()
        .context("fork messages payload missing")?;
    assert!(fork_messages.len() >= 2);
    let first_entry_id = fork_messages[0]["entryId"]
        .as_str()
        .context("fork message entry id missing")?
        .to_string();

    socket
        .send(Message::Text(
            json!({ "type": "fork", "entryId": first_entry_id })
                .to_string()
                .into(),
        ))
        .await
        .context("failed to request fork")?;
    let fork_response = wait_for_response(&mut socket, "fork").await?;
    assert_eq!(fork_response["success"], Value::Bool(true));
    assert_eq!(fork_response["data"]["cancelled"], Value::Bool(false));

    socket
        .send(Message::Text(
            json!({
                "type": "start_task_session",
                "goal": "Stabilize onboarding",
                "constraints": ["Keep browser parity"]
            })
            .to_string()
            .into(),
        ))
        .await
        .context("failed to start task session")?;
    let task_start_response = wait_for_response(&mut socket, "start_task_session").await?;
    assert_eq!(task_start_response["success"], Value::Bool(true));
    assert_eq!(
        task_start_response["data"]["packet"]["goal"],
        Value::String("Stabilize onboarding".to_string())
    );

    socket
        .send(Message::Text(
            json!({
                "type": "complete_task_session",
                "summary": "Stabilized onboarding and returned to parent"
            })
            .to_string()
            .into(),
        ))
        .await
        .context("failed to complete task session")?;
    let task_complete_response = wait_for_response(&mut socket, "complete_task_session").await?;
    assert_eq!(task_complete_response["success"], Value::Bool(true));
    assert_eq!(
        task_complete_response["data"]["resumedParent"],
        Value::Bool(true)
    );

    socket
        .send(Message::Text(
            json!({ "type": "switch_session", "sessionPath": "/tmp/focus.jsonl" })
                .to_string()
                .into(),
        ))
        .await
        .context("failed to switch session")?;
    let switch_response = wait_for_response(&mut socket, "switch_session").await?;
    assert_eq!(switch_response["success"], Value::Bool(true));
    assert_eq!(switch_response["data"]["cancelled"], Value::Bool(false));

    socket
        .close(None)
        .await
        .context("failed to close websocket")?;
    server.stop().await?;

    Ok(())
}

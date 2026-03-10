use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use tracing::{info, warn};

use crate::{rpc::client::RpcClient, rpc::RpcCommand, AppConfig};

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

    let mut client = match RpcClient::spawn(&config.agent.cli_path, &config.agent.cwd).await {
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

pub mod client;

use serde::{Deserialize, Serialize};

/// Commands sent from the browser to the agent (via WebSocket → stdin).
/// Mirrors packages/coding-agent/src/modes/rpc/rpc-types.ts
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RpcCommand {
    Prompt {
        id: Option<String>,
        message: String,
    },
    Abort {
        id: Option<String>,
    },
    NewSession {
        id: Option<String>,
        parent_session: Option<String>,
    },
    GetState {
        id: Option<String>,
    },
}

/// Events streamed from the agent stdout to the browser (via WebSocket).
/// We forward raw JSON — the browser parses the full RpcResponse union.
pub type RpcEventJson = serde_json::Value;

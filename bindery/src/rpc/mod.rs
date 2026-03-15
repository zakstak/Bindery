pub mod client;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcImageContent {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "mimeType", alias = "mime_type")]
    pub mime_type: String,
    pub data: String,
}

/// Commands sent from the browser to the agent (via WebSocket → stdin).
/// Mirrors packages/coding-agent/src/modes/rpc/rpc-types.ts
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RpcCommand {
    Prompt {
        id: Option<String>,
        message: String,
        images: Option<Vec<RpcImageContent>>,
    },
    Abort {
        id: Option<String>,
    },
    NewSession {
        id: Option<String>,
        #[serde(rename = "parentSession", alias = "parent_session")]
        parent_session: Option<String>,
    },
    StartTaskSession {
        id: Option<String>,
        goal: String,
        constraints: Option<Vec<String>>,
        #[serde(rename = "doneDefinition", alias = "done_definition")]
        done_definition: Option<String>,
        notes: Option<String>,
    },
    CompleteTaskSession {
        id: Option<String>,
        summary: String,
        #[serde(rename = "openRisks", alias = "open_risks")]
        open_risks: Option<Vec<String>>,
        #[serde(rename = "nextStep", alias = "next_step")]
        next_step: Option<String>,
        notes: Option<String>,
        #[serde(rename = "resumeParent", alias = "resume_parent")]
        resume_parent: Option<bool>,
    },
    GetState {
        id: Option<String>,
    },
    SetModel {
        id: Option<String>,
        provider: String,
        #[serde(rename = "modelId", alias = "model_id")]
        model_id: String,
    },
    GetAvailableModels {
        id: Option<String>,
    },
    SwitchSession {
        id: Option<String>,
        #[serde(rename = "sessionPath", alias = "session_path")]
        session_path: String,
    },
    Fork {
        id: Option<String>,
        #[serde(rename = "entryId", alias = "entry_id")]
        entry_id: String,
    },
    ExtensionUiResponse {
        id: String,
        value: Option<String>,
        confirmed: Option<bool>,
        cancelled: Option<bool>,
    },
    GetForkMessages {
        id: Option<String>,
    },
}

/// Events streamed from the agent stdout to the browser (via WebSocket).
/// We forward raw JSON — the browser parses the full RpcResponse union.
pub type RpcEventJson = serde_json::Value;

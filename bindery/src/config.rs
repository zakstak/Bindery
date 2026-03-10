use std::{net::SocketAddr, path::Path};

use anyhow::{Context, Result};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct AppConfig {
    pub server: ServerConfig,
    pub agent: AgentConfig,
    pub diffy: Option<DiffyConfig>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ServerConfig {
    pub bind_address: SocketAddr,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentConfig {
    /// Path to the pi CLI entrypoint (pi-test.sh or installed binary).
    pub cli_path: String,
    /// Working directory for the agent subprocess.
    pub cwd: String,
}

/// Optional diffy integration — used in a later pass to render file diffs.
/// See TODO in implementation_plan.md.
#[derive(Debug, Clone, Deserialize)]
pub struct DiffyConfig {
    /// Base URL of the running diffy instance (e.g. "http://127.0.0.1:3001").
    pub url: String,
}

impl AppConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("failed to read config: {}", path.display()))?;
        toml::from_str(&raw).context("failed to parse config")
    }
}

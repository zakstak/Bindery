use std::{collections::HashMap, net::SocketAddr, path::Path};

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
    /// Extra environment variables injected into the agent subprocess.
    /// Useful for mapping infra-specific keys to the names pi expects,
    /// e.g. ZAI_API_KEY = "${SAGA_API_KEY}" (literal value, not shell-expanded).
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Model to select automatically on session start.
    /// Sends a set_model command immediately after spawning the agent.
    pub default_model: Option<DefaultModel>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DefaultModel {
    pub provider: String,
    pub model_id: String,
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
        let mut config: Self = toml::from_str(&raw).context("failed to parse config")?;
        // Expand ${VAR} placeholders in agent.env values.
        for val in config.agent.env.values_mut() {
            if let Some(var_name) = val.strip_prefix("${").and_then(|s| s.strip_suffix('}')) {
                *val = std::env::var(var_name).unwrap_or_default();
            }
        }
        Ok(config)
    }
}

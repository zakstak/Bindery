use anyhow::{Context, Result};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::mpsc,
};

use super::RpcEventJson;

/// Spawns the pi coding agent in RPC mode and provides async send/recv.
pub struct RpcClient {
    _child: Child,
    stdin: ChildStdin,
    pub events: mpsc::Receiver<RpcEventJson>,
}

impl RpcClient {
    /// Spawn agent at `cli_path`, running in `cwd`. Starts background task
    /// reading stdout line-by-line and forwarding parsed JSON to `events`.
    pub async fn spawn(cli_path: &str, cwd: &str) -> Result<Self> {
        let mut child = Command::new("node")
            .arg("--import")
            .arg("tsx/esm")
            .arg(cli_path)
            .arg("--mode")
            .arg("rpc")
            .arg("--no-session")
            .current_dir(cwd)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .context("failed to spawn pi agent")?;

        let stdin = child.stdin.take().context("agent stdin unavailable")?;
        let stdout: ChildStdout = child.stdout.take().context("agent stdout unavailable")?;

        let (tx, rx) = mpsc::channel::<RpcEventJson>(256);

        // Background task: read stdout line-by-line, parse JSON, forward.
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_str::<RpcEventJson>(&line) {
                    Ok(event) => {
                        if tx.send(event).await.is_err() {
                            break; // receiver dropped
                        }
                    }
                    Err(e) => {
                        tracing::warn!("failed to parse agent event: {e} — line: {line}");
                    }
                }
            }
        });

        Ok(Self {
            _child: child,
            stdin,
            events: rx,
        })
    }

    /// Send a command to the agent via stdin (serialized as a JSON line).
    pub async fn send(&mut self, cmd: &super::RpcCommand) -> Result<()> {
        let mut line = serde_json::to_string(cmd).context("failed to serialize command")?;
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .context("failed to write to agent stdin")?;
        Ok(())
    }
}

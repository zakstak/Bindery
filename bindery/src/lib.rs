pub mod config;
pub mod rpc;
pub mod web;

use std::{env, fs, net::SocketAddr};

use anyhow::{Context, Result};
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};
use tracing::info;

pub use config::AppConfig;

pub struct RunningServer {
    pub local_addr: SocketAddr,
    shutdown_tx: Option<oneshot::Sender<()>>,
    task: JoinHandle<Result<()>>,
}

impl RunningServer {
    pub async fn stop(mut self) -> Result<()> {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        self.task.await.context("failed to join server task")??;
        Ok(())
    }
}

pub async fn serve(config: AppConfig) -> Result<RunningServer> {
    let app = web::router(config.clone())?;
    let listener = TcpListener::bind(config.server.bind_address)
        .await
        .with_context(|| format!("failed to bind {}", config.server.bind_address))?;
    let local_addr = listener
        .local_addr()
        .context("failed to resolve listener address")?;
    let (shutdown_tx, shutdown_rx) = oneshot::channel();

    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .context("server exited with an error")
    });

    Ok(RunningServer {
        local_addr,
        shutdown_tx: Some(shutdown_tx),
        task,
    })
}

pub async fn serve_until_shutdown(config: AppConfig) -> Result<()> {
    let server = serve(config).await?;

    info!(address = %server.local_addr, "bindery listening");

    if let Ok(path) = env::var("BINDERY_BIND_ADDRESS_FILE") {
        fs::write(&path, server.local_addr.to_string())
            .with_context(|| format!("failed to write bind address to {path}"))?;
    }

    tokio::signal::ctrl_c()
        .await
        .context("failed to listen for shutdown signal")?;

    server.stop().await
}

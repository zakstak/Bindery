use std::path::PathBuf;

use clap::{Parser, Subcommand};
use bindery::{serve_until_shutdown, AppConfig};

#[derive(Debug, Parser)]
#[command(name = "bindery")]
#[command(about = "Coding agent web UI — loopback Axum server bridging the browser to the agent RPC process")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Serve {
        #[arg(long)]
        config: PathBuf,
    },
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    if let Err(error) = run().await {
        eprintln!("error: {error:#}");
        std::process::exit(1);
    }
}

async fn run() -> anyhow::Result<()> {
    match Cli::parse().command {
        Command::Serve { config } => {
            let config = AppConfig::load(&config)?;
            serve_until_shutdown(config).await
        }
    }
}

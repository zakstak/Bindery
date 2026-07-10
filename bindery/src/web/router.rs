use anyhow::Result;
use axum::{routing::get, Json, Router};
use serde::Serialize;

use crate::AppConfig;

use super::{mock, ui, ws};

#[derive(Debug, Serialize)]
struct HealthPayload {
    status: &'static str,
}

pub fn router(config: AppConfig) -> Result<Router> {
    let ui_router = ui::router(config.clone())?;
    let ws_router = ws::router(config);
    let mock_router = mock::router();

    Ok(Router::new()
        .route("/healthz", get(healthz))
        .merge(ui_router)
        .merge(ws_router)
        .merge(mock_router))
}

async fn healthz() -> Json<HealthPayload> {
    Json(HealthPayload { status: "ok" })
}

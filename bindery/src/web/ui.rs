use anyhow::Result;
use askama::Template;
use axum::{response::Html, routing::get, Router};

use crate::AppConfig;

pub fn router(_config: AppConfig) -> Result<Router> {
    Ok(Router::new()
        .route("/", get(index))
        .route("/mock", get(index)))
}

#[derive(Template)]
#[template(path = "index.html")]
struct IndexTemplate;

async fn index() -> Html<String> {
    Html(IndexTemplate.render().unwrap_or_else(|e| {
        format!("<pre>template error: {e}</pre>")
    }))
}

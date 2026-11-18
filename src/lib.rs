//! The MauNeVi service: the networks `mauro net describe` registers, over
//! HTTP, and the page which draws them.
//!
//! ```text
//! GET /api/health                                 "ok"
//! GET /api/networks                               the index: every scope, network and version
//! GET /api/networks/<scope>/<network>/<version>   one descriptor
//! GET /                                           the viewer (the files under web/)
//! ```
//!
//! The service holds nothing. Every request reads the folder it was pointed
//! at ([`Config::networks_dir`], a checkout of MaUR-O's `networks/`), so
//! publishing a new version is a `git pull` in that checkout and needs no
//! restart. The files are served as they are, after a check that they are JSON
//! and, for a descriptor, that it has a `root`: a file which is not is an error
//! for the one request, and never takes anything else down.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde_json::Value;
use tower_http::services::ServeDir;

/// What the service is started with.
#[derive(Clone, Debug)]
pub struct Config {
    /// The folder of descriptors: `index.json` and `<scope>/<network>/<version>.json`.
    pub networks_dir: PathBuf,
    /// The viewer's files.
    pub web_dir: PathBuf,
    /// Where to listen.
    pub bind: SocketAddr,
    /// A path the whole service is served under, for a reverse proxy which
    /// does not strip it: `""` or `"/maunevi"`.
    pub base_path: String,
}

impl Config {
    /// The configuration of the environment: `MAUNEVI_NETWORKS_DIR`
    /// (`networks`), `MAUNEVI_WEB_DIR` (`web`), `MAUNEVI_BIND`
    /// (`127.0.0.1:8765`) and `MAUNEVI_BASE_PATH` (none).
    pub fn from_env() -> Result<Config, String> {
        let get = |name: &str, default: &str| std::env::var(name).unwrap_or(default.to_string());
        let bind = get("MAUNEVI_BIND", "127.0.0.1:8765");
        Ok(Config {
            networks_dir: get("MAUNEVI_NETWORKS_DIR", "networks").into(),
            web_dir: get("MAUNEVI_WEB_DIR", "web").into(),
            bind: bind
                .parse()
                .map_err(|e| format!("MAUNEVI_BIND={bind:?}: {e}"))?,
            base_path: normalize_base(&get("MAUNEVI_BASE_PATH", "")),
        })
    }
}

/// `"maunevi/"` as `"/maunevi"`, and nothing as nothing.
fn normalize_base(path: &str) -> String {
    let trimmed = path.trim().trim_matches('/');
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("/{trimmed}")
    }
}

/// A name which is safe to turn into a file name: no separators, no leading
/// dot, nothing but letters, digits, `_`, `-` and `.`.
fn safe(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 64
        && !segment.starts_with('.')
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

fn json(body: String) -> Response {
    (
        [
            (header::CONTENT_TYPE, "application/json"),
            // A pull may have changed it since the last request.
            (header::CACHE_CONTROL, "no-cache"),
        ],
        body,
    )
        .into_response()
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, message.to_string()).into_response()
}

async fn health() -> &'static str {
    "ok"
}

async fn index(State(config): State<Arc<Config>>) -> Response {
    let path = config.networks_dir.join("index.json");
    match tokio::fs::read_to_string(&path).await {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(value) if value.get("networks").is_some_and(Value::is_array) => json(text),
            _ => error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "index.json is not an index",
            ),
        },
        // No folder yet is no networks, not a failure.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            json(r#"{"schema_version":1,"networks":[]}"#.to_string())
        }
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "cannot read index.json"),
    }
}

async fn descriptor(
    State(config): State<Arc<Config>>,
    Path((scope, name, version)): Path<(String, String, String)>,
) -> Response {
    if ![&scope, &name, &version].into_iter().all(|s| safe(s)) {
        return error(StatusCode::BAD_REQUEST, "bad name");
    }
    let path = config
        .networks_dir
        .join(&scope)
        .join(&name)
        .join(format!("{version}.json"));
    match tokio::fs::read_to_string(&path).await {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(value) if value.get("root").is_some_and(Value::is_object) => json(text),
            _ => error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "that file is not a network descriptor",
            ),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            error(StatusCode::NOT_FOUND, "no such network version")
        }
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "cannot read that file"),
    }
}

/// The service as a router, ready to be served.
pub fn router(config: &Config) -> Router {
    let state = Arc::new(config.clone());
    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/networks", get(index))
        .route("/api/networks/{scope}/{name}/{version}", get(descriptor))
        .with_state(state)
        .fallback_service(ServeDir::new(&config.web_dir).append_index_html_on_directories(true));
    if config.base_path.is_empty() {
        app
    } else {
        // As a service, so that what is under the prefix is the whole app,
        // viewer fallback included: `nest` would leave that behind.
        let prefix = config.base_path.clone();
        Router::new().nest_service(&prefix, app.into_service::<Body>())
    }
}

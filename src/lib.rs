//! The MauNeVi service: the networks `mauro net describe` registers, over
//! HTTP, and the page which draws them.
//!
//! ```text
//! GET /api/health                                 "ok"
//! GET /api/networks                               the index: every scope, network and version
//! GET /api/networks/<scope>/<network>/<version>   one descriptor
//! GET /api/source                                 where the networks come from, and if they can be pulled
//! POST /api/pull                                  `git pull --ff-only` in that checkout
//! GET /                                           the viewer (the files under web/)
//! ```
//!
//! The service holds nothing. Every request reads the folder it was pointed
//! at ([`Config::networks_dir`], a checkout of MaUR-O's `networks/`), so
//! publishing a new version is a `git pull` in that checkout and needs no
//! restart. The files are served as they are, after a check that they are JSON
//! and, for a descriptor, that it has a `root`: a file which is not is an error
//! for the one request, and never takes anything else down.
//!
//! Pulling is off unless [`Config::pull_repo`] is set: it is the only thing
//! the service ever changes, and only by a fast-forward of the branch which is
//! checked out there.

use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json as json_value, Value};
use tokio::sync::Mutex;
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
    /// The git checkout `networks_dir` is in, if the page may pull it: what
    /// its button does is `git pull --ff-only` there. `None`, no button.
    pub pull_repo: Option<PathBuf>,
}

impl Config {
    /// The configuration of the environment: `MAUNEVI_NETWORKS_DIR`
    /// (`networks`), `MAUNEVI_WEB_DIR` (`web`), `MAUNEVI_BIND`
    /// (`127.0.0.1:8765`), `MAUNEVI_BASE_PATH` (none) and
    /// `MAUNEVI_PULL_REPO` (none: no pulling).
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
            pull_repo: std::env::var_os("MAUNEVI_PULL_REPO")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from),
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

// ------------------------------------------------------------------ pull ---

/// How long a pull may take before it is given up.
const PULL_TIMEOUT: Duration = Duration::from_secs(90);

/// The state the handlers share: the configuration, and the lock which keeps
/// two pulls from running at once.
struct Shared {
    config: Config,
    pulling: Mutex<()>,
}

/// Runs git in `repo` and returns what it printed, or what went wrong. Never
/// asks for anything: a pull which would need a password fails.
async fn git(repo: &FsPath, args: &[&str]) -> Result<String, String> {
    let run = tokio::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(PULL_TIMEOUT, run)
        .await
        .map_err(|_| format!("git {} took more than {}s", args[0], PULL_TIMEOUT.as_secs()))?
        .map_err(|e| format!("cannot run git: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&output.stderr);
        // The last lines say what failed; the rest is progress.
        let tail: Vec<&str> = err.trim().lines().rev().take(6).collect();
        Err(tail.into_iter().rev().collect::<Vec<_>>().join("\n"))
    }
}

/// The branch and commit checked out in `repo`.
async fn head(repo: &FsPath) -> Result<Value, String> {
    let branch = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
    let commit = git(repo, &["rev-parse", "--short", "HEAD"]).await?;
    let date = git(repo, &["log", "-1", "--format=%cI"]).await?;
    Ok(json_value!({ "branch": branch, "commit": commit, "date": date }))
}

async fn source(State(shared): State<Arc<Shared>>) -> Response {
    let Some(repo) = &shared.config.pull_repo else {
        return json(json_value!({ "pull": false }).to_string());
    };
    match head(repo).await {
        Ok(mut at) => {
            at["pull"] = Value::Bool(true);
            json(at.to_string())
        }
        Err(e) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("not a git checkout: {e}"),
        ),
    }
}

async fn pull(State(shared): State<Arc<Shared>>) -> Response {
    let Some(repo) = &shared.config.pull_repo else {
        return error(StatusCode::NOT_FOUND, "pulling is not set up here");
    };
    let Ok(_lock) = shared.pulling.try_lock() else {
        return error(StatusCode::CONFLICT, "a pull is already running");
    };
    let before = match head(repo).await {
        Ok(at) => at,
        Err(e) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("not a git checkout: {e}"),
            )
        }
    };
    // --ff-only: never merge, and never touch what is not a plain update.
    if let Err(e) = git(repo, &["pull", "--ff-only", "--quiet"]).await {
        return error(StatusCode::BAD_GATEWAY, &format!("git pull failed: {e}"));
    }
    match head(repo).await {
        Ok(after) => {
            let changed = before["commit"] != after["commit"];
            json(json_value!({ "before": before, "after": after, "changed": changed }).to_string())
        }
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

/// The service as a router, ready to be served.
pub fn router(config: &Config) -> Router {
    let state = Arc::new(config.clone());
    let shared = Arc::new(Shared {
        config: config.clone(),
        pulling: Mutex::new(()),
    });
    let pulling = Router::new()
        .route("/api/source", get(source))
        .route("/api/pull", post(pull))
        .with_state(shared);
    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/networks", get(index))
        .route("/api/networks/{scope}/{name}/{version}", get(descriptor))
        .with_state(state)
        .merge(pulling)
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

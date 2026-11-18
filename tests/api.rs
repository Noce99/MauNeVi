//! The HTTP surface, driven through the router without a socket.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use maunevi::{router, Config};
use tower::ServiceExt;

fn config(networks: &std::path::Path, web: &std::path::Path, base: &str) -> Config {
    Config {
        networks_dir: networks.to_path_buf(),
        web_dir: web.to_path_buf(),
        bind: "127.0.0.1:0".parse().unwrap(),
        base_path: base.to_string(),
        pull_repo: None,
    }
}

fn fixtures() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/networks")
}

async fn get(config: &Config, uri: &str) -> (StatusCode, String) {
    send(config, Request::get(uri).body(Body::empty()).unwrap()).await
}

async fn post(config: &Config, uri: &str) -> (StatusCode, String) {
    send(config, Request::post(uri).body(Body::empty()).unwrap()).await
}

async fn send(config: &Config, request: Request<Body>) -> (StatusCode, String) {
    let response = router(config).oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

#[tokio::test]
async fn health_says_ok() {
    let web = tempfile::tempdir().unwrap();
    let config = config(&fixtures(), web.path(), "");
    assert_eq!(
        get(&config, "/api/health").await,
        (StatusCode::OK, "ok".into())
    );
}

#[tokio::test]
async fn the_index_lists_the_networks_of_the_folder() {
    let web = tempfile::tempdir().unwrap();
    let (status, body) = get(&config(&fixtures(), web.path(), ""), "/api/networks").await;
    assert_eq!(status, StatusCode::OK);
    let index: serde_json::Value = serde_json::from_str(&body).unwrap();
    let names: Vec<&str> = index["networks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["name"].as_str().unwrap())
        .collect();
    assert!(
        names.contains(&"tree") && names.contains(&"unet"),
        "{names:?}"
    );
}

#[tokio::test]
async fn a_missing_folder_is_an_empty_index_not_an_error() {
    let web = tempfile::tempdir().unwrap();
    let nothing = web.path().join("nothing");
    let (status, body) = get(&config(&nothing, web.path(), ""), "/api/networks").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains(r#""networks":[]"#));
}

#[tokio::test]
async fn a_descriptor_is_served_and_unknown_ones_are_404() {
    let web = tempfile::tempdir().unwrap();
    let config = config(&fixtures(), web.path(), "");
    let (status, body) = get(&config, "/api/networks/image_to_omap/tree/0.1").await;
    assert_eq!(status, StatusCode::OK);
    let descriptor: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(descriptor["name"], "tree");
    assert_eq!(descriptor["version"], "0.1");

    let (status, _) = get(&config, "/api/networks/image_to_omap/tree/9.9").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn names_which_could_leave_the_folder_are_refused() {
    let web = tempfile::tempdir().unwrap();
    let config = config(&fixtures(), web.path(), "");
    for uri in [
        "/api/networks/..%2F..%2Fetc/passwd/0.1",
        "/api/networks/image_to_omap/.hidden/0.1",
        "/api/networks/image_to_omap/tree/..",
        "/api/networks/image_to_omap/tr%00ee/0.1",
    ] {
        let (status, _) = get(&config, uri).await;
        assert!(
            status == StatusCode::BAD_REQUEST || status == StatusCode::NOT_FOUND,
            "{uri}: {status}"
        );
    }
}

#[tokio::test]
async fn a_file_which_is_not_a_descriptor_fails_alone() {
    let dir = tempfile::tempdir().unwrap();
    let web = tempfile::tempdir().unwrap();
    let folder = dir.path().join("s/n");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("0.1.json"), "not json").unwrap();
    std::fs::write(folder.join("0.2.json"), r#"{"root":{"id":"x"}}"#).unwrap();
    let config = config(dir.path(), web.path(), "");

    assert_eq!(
        get(&config, "/api/networks/s/n/0.1").await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        get(&config, "/api/networks/s/n/0.2").await.0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn the_viewer_is_served_from_the_web_folder() {
    let web = tempfile::tempdir().unwrap();
    std::fs::write(web.path().join("index.html"), "<title>hi</title>").unwrap();
    let config = config(&fixtures(), web.path(), "");
    let (status, body) = get(&config, "/").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("<title>hi</title>"));
}

#[tokio::test]
async fn everything_can_live_under_a_base_path() {
    let web = tempfile::tempdir().unwrap();
    std::fs::write(web.path().join("index.html"), "page").unwrap();
    let config = config(&fixtures(), web.path(), "/maunevi");
    assert_eq!(get(&config, "/maunevi/api/health").await.0, StatusCode::OK);
    assert_eq!(
        get(&config, "/maunevi/").await,
        (StatusCode::OK, "page".into())
    );
    assert_eq!(get(&config, "/api/health").await.0, StatusCode::NOT_FOUND);
}

// ------------------------------------------------------------------ pull ---

/// Runs git in `dir`, as nobody in particular, and returns what it printed.
fn git(dir: &std::path::Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=test", "-c", "user.email=test@example.org"])
        .args([
            "-c",
            "init.defaultBranch=main",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// An "upstream" repository with a networks/ folder, and a clone of it as the
/// service would have.
fn upstream_and_clone() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let upstream = dir.path().join("upstream");
    std::fs::create_dir_all(upstream.join("networks")).unwrap();
    git(&upstream, &["init", "-q"]);
    std::fs::write(
        upstream.join("networks/index.json"),
        r#"{"schema_version":1,"networks":[]}"#,
    )
    .unwrap();
    git(&upstream, &["add", "."]);
    git(&upstream, &["commit", "-q", "-m", "first"]);
    let clone = dir.path().join("clone");
    git(
        dir.path(),
        &["clone", "-q", upstream.to_str().unwrap(), "clone"],
    );
    (dir, upstream, clone)
}

fn pulling(clone: &std::path::Path, web: &std::path::Path) -> Config {
    let mut config = config(&clone.join("networks"), web, "");
    config.pull_repo = Some(clone.to_path_buf());
    config
}

#[tokio::test]
async fn without_a_repo_there_is_no_pulling() {
    let web = tempfile::tempdir().unwrap();
    let config = config(&fixtures(), web.path(), "");
    let (status, body) = get(&config, "/api/source").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, r#"{"pull":false}"#);
    assert_eq!(post(&config, "/api/pull").await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_source_says_which_branch_and_commit() {
    let (_dir, upstream, clone) = upstream_and_clone();
    let web = tempfile::tempdir().unwrap();
    let (status, body) = get(&pulling(&clone, web.path()), "/api/source").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let source: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(source["pull"], true);
    assert_eq!(source["branch"], "main");
    assert_eq!(
        source["commit"],
        git(&upstream, &["rev-parse", "--short", "HEAD"])
    );
}

#[tokio::test]
async fn a_pull_brings_in_what_upstream_has_and_the_index_shows_it() {
    let (_dir, upstream, clone) = upstream_and_clone();
    let web = tempfile::tempdir().unwrap();
    let config = pulling(&clone, web.path());

    // Nothing new: a pull changes nothing.
    let (status, body) = post(&config, "/api/pull").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains(r#""changed":false"#), "{body}");

    // A new network upstream.
    std::fs::write(
        upstream.join("networks/index.json"),
        r#"{"schema_version":1,"networks":[{"scope":"s","name":"new"}]}"#,
    )
    .unwrap();
    git(&upstream, &["commit", "-q", "-am", "a new network"]);
    let (status, body) = post(&config, "/api/pull").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let pulled: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(pulled["changed"], true);
    assert_eq!(
        pulled["after"]["commit"],
        git(&upstream, &["rev-parse", "--short", "HEAD"])
    );
    assert_ne!(pulled["before"]["commit"], pulled["after"]["commit"]);
    assert!(get(&config, "/api/networks").await.1.contains(r#""new""#));
}

#[tokio::test]
async fn a_pull_which_is_not_a_fast_forward_fails_and_changes_nothing() {
    let (_dir, upstream, clone) = upstream_and_clone();
    let web = tempfile::tempdir().unwrap();
    let config = pulling(&clone, web.path());
    // The two have gone separate ways.
    std::fs::write(upstream.join("networks/a"), "upstream").unwrap();
    git(&upstream, &["add", "."]);
    git(&upstream, &["commit", "-q", "-m", "upstream"]);
    std::fs::write(clone.join("networks/b"), "local").unwrap();
    git(&clone, &["add", "."]);
    git(&clone, &["commit", "-q", "-m", "local"]);
    let local = git(&clone, &["rev-parse", "HEAD"]);

    let (status, body) = post(&config, "/api/pull").await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
    assert!(body.starts_with("git pull failed"), "{body}");
    assert_eq!(git(&clone, &["rev-parse", "HEAD"]), local);
}

#[tokio::test]
async fn pulling_is_a_post() {
    let (_dir, _upstream, clone) = upstream_and_clone();
    let web = tempfile::tempdir().unwrap();
    let (status, _) = get(&pulling(&clone, web.path()), "/api/pull").await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
}

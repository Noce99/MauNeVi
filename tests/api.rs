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
    }
}

fn fixtures() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/networks")
}

async fn get(config: &Config, uri: &str) -> (StatusCode, String) {
    let response = router(config)
        .oneshot(Request::get(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
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

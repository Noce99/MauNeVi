//! `maunevi`: runs the service. Configured by the environment; see
//! [`maunevi::Config::from_env`].

use maunevi::{router, Config};

#[tokio::main]
async fn main() -> std::process::ExitCode {
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(message) => {
            eprintln!("maunevi: {message}");
            return std::process::ExitCode::from(1);
        }
    };
    let listener = match tokio::net::TcpListener::bind(config.bind).await {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("maunevi: cannot listen on {}: {e}", config.bind);
            return std::process::ExitCode::from(2);
        }
    };
    eprintln!(
        "maunevi: http://{}{}/  networks from {}",
        config.bind,
        config.base_path,
        config.networks_dir.display()
    );
    if let Some(repo) = &config.pull_repo {
        eprintln!("maunevi: the page may pull {}", repo.display());
    }
    let served = axum::serve(listener, router(&config))
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c().await.ok();
        })
        .await;
    match served {
        Ok(()) => std::process::ExitCode::from(0),
        Err(e) => {
            eprintln!("maunevi: {e}");
            std::process::ExitCode::from(2)
        }
    }
}

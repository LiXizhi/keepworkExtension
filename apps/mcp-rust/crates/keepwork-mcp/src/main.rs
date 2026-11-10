//! `keepwork-mcp` entry point. Binds loopback only; an occupied port means the
//! daemon is already running (single-daemon rule), which is not an error.

use keepwork_mcp::config::InstanceInfo;
use keepwork_mcp::http::{self, AppState};
use keepwork_mcp::identity::Identity;
use keepwork_mcp::{cli, config, mcp, paths};
use std::sync::Arc;

fn main() {
    let args = match cli::parse(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    if args.help {
        println!("{}", cli::USAGE);
        return;
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("keepwork-mcp: cannot start runtime: {error}");
            std::process::exit(1);
        }
    };
    std::process::exit(runtime.block_on(run(args)));
}

async fn run(args: cli::Args) -> i32 {
    let port = config::resolve_port(args.port);
    let require_auth = config::resolve_require_auth(args.require_auth);
    let root = paths::resolve_workspace_root(args.root.as_deref());
    let token = match config::read_or_create_token() {
        Ok(token) => token,
        Err(error) => {
            eprintln!("keepwork-mcp: cannot read token: {error}");
            return 1;
        }
    };
    let identity = Identity::from_env(
        std::env::var("KEEPWORK_MCP_HOST_KIND").ok(),
        std::env::var("KEEPWORK_MCP_HOST_VERSION").ok(),
    );
    let started_at = http::now_iso();
    let state = Arc::new(AppState::new(
        port,
        root.clone(),
        require_auth,
        token,
        identity,
    ));

    let listener = match tokio::net::TcpListener::bind((config::BIND_HOST, port)).await {
        Ok(listener) => listener,
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            println!("keepwork-mcp already running on port {port}");
            return 0;
        }
        Err(error) => {
            eprintln!("keepwork-mcp failed to listen on {port}: {error}");
            return 1;
        }
    };

    let _ = config::write_instance(&InstanceInfo {
        pid: std::process::id(),
        port,
        started_at: started_at.clone(),
        name: keepwork_mcp::SERVER_NAME.to_string(),
    });
    println!(
        "keepwork-mcp listening on http://{}:{}/mcp",
        config::BIND_HOST,
        port
    );
    println!("dashboard: http://{}:{}/dashboard", config::BIND_HOST, port);
    println!("workspace root: {}", root.display());
    println!(
        "auth: {}",
        if require_auth {
            "token required"
        } else {
            "open (no token)"
        }
    );

    let prune_state = Arc::clone(&state);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            mcp::prune_idle(&prune_state);
        }
    });

    let app = http::router(state);
    let server = axum::serve(listener, app).with_graceful_shutdown(shutdown_signal());
    let code = match server.await {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("keepwork-mcp server error: {error}");
            1
        }
    };
    config::clear_instance();
    code
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut terminate = match signal(SignalKind::terminate()) {
            Ok(stream) => stream,
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

mod agent_hook;
mod attach;
mod config;
mod console;
mod daemon;
mod hook;
mod protocol;
mod proxy;
mod setup;

use anyhow::Result;
use clap::{Parser, Subcommand};
use config::{load_config, save_config, RiftConfig};

#[derive(Parser)]
#[command(
    name = "rift",
    version,
    about = "Rift — ultra-thin cross-platform terminal mirror & multi-host web relay client"
)]
struct Cli {
    /// Relay server URL (overrides ~/.rift/config.json)
    #[arg(long)]
    relay: Option<String>,

    /// Host display name & ID (overrides ~/.rift/config.json)
    #[arg(long)]
    host: Option<String>,

    /// Initial tab title
    #[arg(long)]
    title: Option<String>,

    /// Shared agent secret
    #[arg(long)]
    secret: Option<String>,

    /// Headless mode (do not attach local stdin/stdout)
    #[arg(long)]
    no_local: bool,

    /// Initial columns (headless override)
    #[arg(long)]
    cols: Option<u16>,

    /// Initial rows (headless override)
    #[arg(long)]
    rows: Option<u16>,

    #[command(subcommand)]
    subcommand: Option<Commands>,

    /// Shell command to launch (after `--`)
    #[arg(last = true)]
    command: Vec<String>,
}

#[derive(Subcommand)]
enum Commands {
    /// One-command setup: save config, install hooks (Win), register AI agent reporters & autostart daemon
    Setup {
        /// Relay server URL (required, e.g. https://term.example.com)
        #[arg(long)]
        relay: String,
        /// Host display name & ID (default: machine hostname)
        #[arg(long)]
        host: Option<String>,
        /// Shared agent registration secret
        #[arg(long)]
        secret: Option<String>,
        /// Web access token (used by `rift attach`)
        #[arg(long)]
        token: Option<String>,
        /// Skip shell & AI agent hook installation
        #[arg(long)]
        no_hook: bool,
        /// Also install shell hooks on Linux/macOS (off by default on servers)
        #[arg(long)]
        with_hook: bool,
        /// Skip autostart registration & daemon launch
        #[arg(long)]
        no_autostart: bool,
    },
    /// Cleanly remove autostart daemon, shell hooks, and AI agent hooks
    Uninstall {
        /// Also remove ~/.rift directory and config
        #[arg(long)]
        purge: bool,
    },
    /// Initialize or update ~/.rift/config.json only
    Init {
        #[arg(long)]
        relay: Option<String>,
        #[arg(long)]
        host: Option<String>,
        #[arg(long)]
        secret: Option<String>,
        #[arg(long)]
        token: Option<String>,
        #[arg(long)]
        shell: Option<String>,
    },
    /// Keep this host online in the background so remote `+` works even with 0 open terminals
    Daemon,
    /// Attach local terminal to an existing online session (press Ctrl+] to detach)
    Attach {
        #[arg(long)]
        token: Option<String>,
        /// Optional sessionId (full or prefix)
        session_id: Option<String>,
    },
    /// Report active AI agent state (invoked by agy / claude / codex lifecycle hooks)
    AgentHook {
        #[arg(long)]
        agent: String,
        #[arg(long)]
        event: String,
        #[arg(long)]
        session_id: Option<String>,
        /// Print `{}` to stdout after reporting (required by JSON hook protocols like agy)
        #[arg(long)]
        print_json: bool,
        /// Print `{"decision":"<val>"}` (e.g. `ask` for agy PreToolUse passthrough)
        #[arg(long)]
        decision: Option<String>,
    },
    /// Install or uninstall shell startup hook only
    Hook {
        #[command(subcommand)]
        action: HookAction,
    },
}

#[derive(Subcommand)]
enum HookAction {
    /// Automatically mirror new terminals into Rift (adds anti-recursion guard)
    Install,
    /// Remove the Rift auto-mirror hook cleanly
    Uninstall,
}

#[tokio::main]
async fn main() -> Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let cli = Cli::parse();
    let mut cfg: RiftConfig = load_config();
    if let Some(r) = cli.relay {
        cfg.relay = r;
    }
    if let Some(h) = cli.host {
        cfg.host = h;
    }
    if let Some(s) = cli.secret {
        cfg.secret = s;
    }

    match cli.subcommand {
        Some(Commands::Setup {
            relay,
            host,
            secret,
            token,
            no_hook,
            with_hook,
            no_autostart,
        }) => {
            cfg.relay = relay;
            if let Some(h) = host {
                cfg.host = h;
            }
            if let Some(s) = secret {
                cfg.secret = s;
            }
            if let Some(t) = token {
                cfg.token = t;
            }
            setup::run_setup(setup::SetupOptions {
                config: cfg,
                no_hook,
                with_hook,
                no_autostart,
            })
        }
        Some(Commands::Uninstall { purge }) => setup::run_uninstall(purge),
        Some(Commands::Init {
            relay,
            host,
            secret,
            token,
            shell,
        }) => {
            if let Some(r) = relay {
                cfg.relay = r;
            }
            if let Some(h) = host {
                cfg.host = h;
            }
            if let Some(s) = secret {
                cfg.secret = s;
            }
            if let Some(t) = token {
                cfg.token = t;
            }
            if let Some(sh) = shell {
                cfg.shell = sh;
            }
            let path = save_config(&cfg)?;
            println!("[rift] 配置已保存至: {}", path.display());
            println!("{}", serde_json::to_string_pretty(&cfg)?);
            Ok(())
        }
        Some(Commands::Daemon) => daemon::run_daemon(cfg).await,
        Some(Commands::Attach { token, session_id }) => {
            if let Some(t) = token {
                cfg.token = t;
            }
            attach::run_attach(cfg, session_id).await
        }
        Some(Commands::AgentHook {
            agent,
            event,
            session_id,
            print_json,
            decision,
        }) => {
            agent_hook::run_agent_hook(cfg, agent, event, session_id, print_json, decision).await;
            Ok(())
        }
        Some(Commands::Hook { action }) => match action {
            HookAction::Install => hook::install_hook(),
            HookAction::Uninstall => hook::uninstall_hook(),
        },
        None => {
            let code = proxy::run_proxy(proxy::ProxyRunOptions {
                config: cfg,
                title: cli.title,
                no_local: cli.no_local,
                cols: cli.cols,
                rows: cli.rows,
                command: cli.command,
            })
            .await?;
            std::process::exit(code);
        }
    }
}

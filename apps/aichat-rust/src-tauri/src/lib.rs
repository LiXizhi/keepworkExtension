pub mod brain_folder;
pub mod bridge;
pub mod deployment;
pub mod desktop_identity;
pub mod desktop_lock;
pub mod dev_server;
pub mod files;
pub mod git_setup;
pub mod installer_stop;
pub mod login_startup;
pub mod menu;
pub mod navigation;
pub mod page_connection;
pub mod permissions;
pub mod pet;
pub mod pet_audio;
pub mod pet_canvas;
pub mod pet_menu;
pub mod runtime;
pub mod remote_voice;
pub mod security;
pub mod terminal;
pub mod theme;
pub mod tray_channels;
pub mod updates;

mod app;

pub use app::{
    ensure_pet_window, execute_host_command, open_in_system_browser, open_updates_window,
    resolve_profile_dir, reveal_path_in_os, run, show_main_window, AppCore, DesktopStatus,
};

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

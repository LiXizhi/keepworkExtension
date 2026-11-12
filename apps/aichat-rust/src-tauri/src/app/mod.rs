//! Application composition. Domain modules above this layer remain independent
//! of Tauri window and command wiring.

mod browser_surface;
mod commands;
mod events;
mod host_menu;
mod main_window;
mod pet_audio_host;
mod pet_host;
mod platform;
mod remote_voice_host;
mod sender;
mod startup;
mod state;
mod updates_window;

pub use host_menu::execute_host_command;
pub use main_window::show_main_window;
pub use pet_host::ensure_pet_window;
pub use platform::{open_in_system_browser, reveal_path_in_os};
pub use startup::run;
pub use state::{resolve_profile_dir, AppCore, DesktopStatus};
pub use updates_window::open_updates_window;

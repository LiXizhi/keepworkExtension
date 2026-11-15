#pragma once
namespace keepwork_cef {
enum class WindowCommand {
  reload = 1000, reload_no_cache, open_browser, close,
  undo, redo, cut, copy, paste, select_all,
  zoom_in, zoom_out, zoom_reset, fullscreen,
  dashboard, about, quit, open_entry, start_mcp
};
}

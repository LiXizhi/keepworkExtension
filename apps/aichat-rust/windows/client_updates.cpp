#include "client_updates.hpp"
#include "common/archive.hpp"
#include "common/client_update_policy.hpp"
#include <shellapi.h>
#include <fstream>
#include <optional>
#include <array>
#include <cstdio>

namespace keepwork {
namespace fs = std::filesystem;
namespace {
using json = nlohmann::json;
void require(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
fs::path updates_root() {
  auto root = local_data() / L"KeepworkWin7Win8" / L"Updates";
  plain_path(root); fs::create_directories(root); return root;
}
std::string read(const fs::path& file, std::uint64_t cap = 2 * 1024 * 1024) {
  plain_path(file);
  require(fs::is_regular_file(file) && fs::file_size(file) <= cap, "Invalid client update metadata");
  std::ifstream stream(file, std::ios::binary);
  std::string text((std::istreambuf_iterator<char>(stream)), {});
  require(!stream.bad(), "Cannot read client update metadata"); return text;
}
void save(const fs::path& file, const std::string& text) {
  plain_path(file);
  auto partial = file; partial += L".tmp"; plain_path(partial);
  std::ofstream output(partial, std::ios::binary | std::ios::trunc);
  output.write(text.data(), static_cast<std::streamsize>(text.size())); output.close();
  require(bool(output), "Cannot save client update metadata");
  require(MoveFileExW(partial.c_str(), file.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0,
    "Cannot activate client update metadata");
}
std::string timestamp() {
  SYSTEMTIME time{}; GetSystemTime(&time); char text[32]{};
  std::snprintf(text, sizeof(text), "%04u-%02u-%02uT%02u:%02u:%02uZ", time.wYear, time.wMonth,
    time.wDay, time.wHour, time.wMinute, time.wSecond); return text;
}
std::string current_version() {
  const auto installed = json::parse(read(executable_dir() / L"win7-edition.json"));
  require(installed.at("product") == "aichat-desktop" && installed.at("variant") == "win7-win8"
    && installed.at("arch") == "x64", "Not an installed compatibility client");
  auto version = installed.at("version").get<std::string>(); (void)client_version(version); return version;
}
fs::path installer_path(const fs::path& root, const ClientUpdateManifest& manifest) {
  auto file = root / (manifest.sha256 + "-setup.exe"); plain_path(file); return file;
}
void verify_installer(const fs::path& file, const ClientUpdateManifest& manifest) {
  plain_path(file);
  require(fs::is_regular_file(file) && fs::file_size(file) == manifest.size
    && sha256_file(file) == manifest.sha256, "Downloaded client update integrity check failed");
}
struct Pending { std::string envelope; ClientUpdateManifest manifest; fs::path installer; };
std::optional<Pending> restore_pending(const fs::path& root, const std::string& current) {
  if (!fs::exists(root / L"pending.signed.json")) return std::nullopt;
  auto envelope = read(root / L"pending.signed.json");
  auto manifest = validate_win7_client_manifest(verify_client_update_envelope(envelope));
  if (client_version(manifest.version) <= client_version(current)) return std::nullopt;
  auto file = installer_path(root, manifest); verify_installer(file, manifest);
  return Pending{envelope, manifest, file};
}
void project_pending(json& state, const std::optional<Pending>& pending) {
  state["ready"] = pending.has_value();
  state["pendingDigest"] = pending ? pending->manifest.sha256 : "";
  state["pendingVersion"] = pending ? pending->manifest.version : "";
}
json initial_state(const fs::path& root, const std::string& current) {
  json state{{"schemaVersion", 1}, {"state", "idle"}, {"currentVersion", current},
    {"latestVersion", ""}, {"releaseDate", ""}, {"checkedAt", ""},
    {"stale", true}, {"error", ""}, {"ready", false}, {"pendingDigest", ""}, {"pendingVersion", ""}};
  try {
    const auto latest = validate_win7_client_manifest(verify_client_update_envelope(read(root / L"latest.signed.json")));
    state["latestVersion"] = latest.version; state["releaseDate"] = latest.release_date;
    const auto old = json::parse(read(root / L"state.json", 65536));
    if (old.contains("checkedAt") && old.at("checkedAt").is_string()
        && old.at("checkedAt").get_ref<const std::string&>().size() <= 64) state["checkedAt"] = old.at("checkedAt");
  } catch (...) { /* Missing/stale metadata never enables installation. */ }
  return state;
}
void publish(const fs::path& root, const json& state) { save(root / L"state.json", state.dump(2)); }
std::string bounded_error(const std::exception& error) {
  auto value = std::string(error.what()); if (value.size() > 512) value = "Compatibility update operation failed; check the local service log.";
  for (char& c : value) if (static_cast<unsigned char>(c) < 32 || c == 127) c = ' ';
  return value;
}
void verify_parent_image(HANDLE process) {
  std::array<wchar_t, 32768> buffer{}; DWORD size = static_cast<DWORD>(buffer.size());
  require(QueryFullProcessImageNameW(process, 0, buffer.data(), &size) != FALSE, "Cannot verify the chat process");
  const auto image = fs::path(std::wstring(buffer.data(), size)); plain_path(image);
  const auto cache = local_data() / L"Keepwork" / L"BrowserRuntimes" / L"legacy" / L"x64";
  const auto manifest = validate_manifest(verify_envelope(read(cache / L"active.json")), "legacy", "x64", {6, 1, 7601});
  const auto directory = cache / L"versions" / manifest.sha256;
  const auto expected = directory / L"keepwork-cef.exe"; plain_path(expected);
  require(_wcsicmp(fs::canonical(image).c_str(), fs::canonical(expected).c_str()) == 0,
    "The update request did not come from this client's verified chat host");
  verify_package(directory, manifest, sha256_file);
  require(WaitForSingleObject(process, 0) == WAIT_TIMEOUT, "The chat process already exited before update preparation");
}
struct InstallOperation {
  fs::path root;
  std::string current, approved;
  DWORD pid;
  std::wstring event, cancellation, acknowledged_close;
  const Progress& progress;
  std::optional<Pending> pending;
  Handle parent{}, binary{}, cancel{}, closed{};
  void prepare() {
    require(pid != 0 && pid != GetCurrentProcessId(), "Invalid chat process for update");
    parent.value = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    require(parent.value != nullptr, "Cannot wait for the chat process"); verify_parent_image(parent.value);
    pending = restore_pending(root, current); require(pending.has_value(), "No verified downloaded client update is available");
    require_client_update_digest(pending->manifest.sha256, approved);
    // Retain a non-writable, non-deletable handle through verification and
    // ShellExecute, closing the verification-to-execution replacement window.
    binary.value = CreateFileW(pending->installer.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    require(binary.value != INVALID_HANDLE_VALUE, "Cannot lock the downloaded installer");
    verify_installer(pending->installer, pending->manifest);
  }
  void signal_ready() {
    require(event.size() > 28 && event.size() <= 160 && event.rfind(L"Local\\Keepwork.Update.Ready.", 0) == 0,
      "Invalid update readiness event");
    const std::wstring prefix = L"Local\\Keepwork.Update.Ready.";
    require(cancellation == L"Local\\Keepwork.Update.Cancel." + event.substr(prefix.size()),
      "Invalid update cancellation event");
    require(acknowledged_close == L"Local\\Keepwork.Update.Closed." + event.substr(prefix.size()),
      "Invalid update shutdown event");
    cancel.value = OpenEventW(SYNCHRONIZE, FALSE, cancellation.c_str());
    require(cancel.value != nullptr, "Cannot observe update cancellation");
    closed.value = OpenEventW(SYNCHRONIZE, FALSE, acknowledged_close.c_str());
    require(closed.value != nullptr, "Cannot observe normal chat shutdown");
    Handle ready(OpenEventW(EVENT_MODIFY_STATE, FALSE, event.c_str()));
    require(ready.value && SetEvent(ready.value), "Cannot acknowledge update readiness");
  }
  bool wait_for_parent_exit() {
    const auto started = GetTickCount64();
    for (;;) {
      progress(L"正在等待聊天窗口退出，取消退出将保留更新…", 0, 0);
      const HANDLE handles[]{cancel.value, parent.value};
      const auto result = WaitForMultipleObjects(2, handles, FALSE, 100);
      if (result == WAIT_OBJECT_0) return false;
      if (result == WAIT_OBJECT_0 + 1) return true;
      require(result == WAIT_TIMEOUT, "Cannot observe chat shutdown");
      if (GetTickCount64() - started >= 60000) return false;
    }
  }
  void revalidate() {
    require(WaitForSingleObject(cancel.value, 0) == WAIT_TIMEOUT, "Update installation was canceled");
    require(WaitForSingleObject(parent.value, 0) == WAIT_OBJECT_0, "Chat is still running");
    require(WaitForSingleObject(closed.value, 0) == WAIT_OBJECT_0, "Chat did not acknowledge normal shutdown; the update was retained");
    const auto chosen = validate_win7_client_manifest(verify_client_update_envelope(pending->envelope));
    require_client_update_digest(chosen.sha256, approved);
    const auto latest_choice = validate_win7_client_manifest(verify_client_update_envelope(read(root / L"pending.signed.json")));
    require_client_update_digest(latest_choice.sha256, approved);
    require(latest_choice.version == chosen.version && latest_choice.size == chosen.size,
      "The pending update changed during shutdown; check and confirm it again");
    verify_installer(pending->installer, chosen);
  }
  void launch_installer() {
    require(WaitForSingleObject(cancel.value, 0) == WAIT_TIMEOUT, "Update installation was canceled");
    require(WaitForSingleObject(closed.value, 0) == WAIT_OBJECT_0, "Normal chat shutdown is required before updating");
    // /D is last because NSIS treats the remainder as the directory, including
    // spaces. It comes from the running launcher's fixed installed directory.
    const auto arguments = L"/UPDATE /D=" + executable_dir().wstring();
    require(reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr, L"open", pending->installer.c_str(),
      arguments.c_str(), root.c_str(), SW_SHOWNORMAL)) > 32, "Cannot start the verified compatibility installer");
  }
};
}
nlohmann::json check_win7_client_update(const Progress& progress) {
  const auto root = updates_root(); const auto current = current_version();
  auto state = initial_state(root, current);
  std::optional<Pending> pending;
  try { pending = restore_pending(root, current); } catch (...) { /* Invalid old candidates cannot apply. */ }
  std::optional<ClientUpdateManifest> last_latest;
  try { last_latest = validate_win7_client_manifest(verify_client_update_envelope(read(root / L"latest.signed.json"))); }
  catch (...) { /* Only a verified historical envelope establishes immutable identity. */ }
  project_pending(state, pending);
  try {
    state["state"] = "checking"; publish(root, state);
    progress(L"正在检查 Keepwork 软件更新…", 0, 0);
    const auto envelope = fetch_manifest(std::string(win7_client_base) + "windows-x64/latest-client.json", progress);
    const auto remote = validate_win7_client_manifest(verify_client_update_envelope(envelope));
    const bool older_than_installed = client_version(remote.version) < client_version(current);
    // A development/preview client can legitimately be ahead of the official
    // channel. Retain downgrade/immutability protection against known releases,
    // but report no installable update rather than a broken connection.
    const auto& selection_floor = older_than_installed ? remote.version : current;
    validate_client_update_choice(selection_floor, remote, pending ? &pending->manifest : nullptr);
    // Even an interrupted download establishes the signed version's identity.
    // Losing/damaging the pending installer must not permit same-version bytes
    // to change on a subsequent check.
    validate_client_update_choice(selection_floor, remote, last_latest ? &*last_latest : nullptr);
    state["latestVersion"] = remote.version; state["releaseDate"] = remote.release_date;
    state["checkedAt"] = timestamp(); state["stale"] = false; state["error"] = "";
    save(root / L"latest.signed.json", envelope);
    if (client_version(remote.version) > client_version(current) && (!pending || pending->manifest.sha256 != remote.sha256)) {
      state["state"] = "downloading"; publish(root, state);
      const auto file = installer_path(root, remote); auto partial = root / (remote.sha256 + ".part"); plain_path(partial);
      if (!fs::exists(file)) {
        try {
          download(remote.url, partial, remote.size, [&](const std::wstring&, std::uint64_t done, std::uint64_t total) {
            progress(L"正在下载 Keepwork " + wide(remote.version) + L"…", done, total);
          });
          verify_installer(partial, remote); fs::rename(partial, file);
        } catch (...) { std::error_code ignored; fs::remove(partial, ignored); throw; }
      }
      verify_installer(file, remote); save(root / L"pending.signed.json", envelope);
      pending = Pending{envelope, remote, file};
    }
    project_pending(state, pending); state["state"] = pending ? "ready" : "current"; publish(root, state);
    return state;
  } catch (const std::exception& error) {
    state["stale"] = true; state["error"] = bounded_error(error);
    project_pending(state, pending); state["state"] = pending ? "ready" : "error";
    publish(root, state); throw;
  }
}
void install_win7_client_update(DWORD parent_pid, const std::wstring& ready_event, const std::wstring& cancel_event,
    const std::wstring& closed_event, const std::string& approved_digest, const Progress& progress) {
  const auto root = updates_root(); const auto current = current_version();
  InstallOperation operation{root, current, approved_digest, parent_pid, ready_event, cancel_event, closed_event, progress};
  try { apply_prepared_client_update(operation); }
  catch (const std::exception& error) {
    auto state = initial_state(root, current);
    std::optional<Pending> pending;
    try { pending = restore_pending(root, current); } catch (...) {}
    project_pending(state, pending); state["state"] = pending ? "ready" : "error";
    state["error"] = bounded_error(error); state["stale"] = true; publish(root, state); throw;
  }
}
}

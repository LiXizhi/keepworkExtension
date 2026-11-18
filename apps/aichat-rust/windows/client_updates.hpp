#pragma once
#include "native.hpp"
#include <nlohmann/json.hpp>

namespace keepwork {
// Local state is display metadata only; installation re-verifies the signed
// pending envelope and installer bytes against the approved digest.
nlohmann::json check_win7_client_update(const Progress& progress);
void install_win7_client_update(DWORD parent_pid, const std::wstring& ready_event, const std::wstring& cancel_event,
    const std::wstring& closed_event, const std::string& approved_digest, const Progress& progress);
}

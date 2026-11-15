#pragma once
#include "native.hpp"

namespace keepwork {
// Prepare an independently signed runtime. An occupied port is attached to,
// never taken over. Updates remain pending until that candidate starts healthy.
void start_win7_mcp(bool update, const Progress& progress);
bool restart_win7_mcp(const Progress& progress, const std::function<bool()>& confirm);
void update_win7_client(const Progress& progress);
void win7_startup_warning(const std::string& message);
}

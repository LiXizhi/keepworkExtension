cmake_minimum_required(VERSION 3.21)
cmake_policy(SET CMP0091 NEW)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
project(keepwork_cef_host LANGUAGES C CXX)

option(KEEPWORK_POLICY_TESTS_ONLY "Build portable navigation tests without the Windows SDK or CEF" OFF)
enable_testing()
add_executable(cef-navigation-test navigation_policy_test.cpp)
target_compile_features(cef-navigation-test PRIVATE cxx_std_17)
add_test(NAME cef-navigation COMMAND cef-navigation-test)
add_executable(cef-window-geometry-test window_geometry_test.cpp)
target_compile_features(cef-window-geometry-test PRIVATE cxx_std_17)
add_test(NAME cef-window-geometry COMMAND cef-window-geometry-test)
add_executable(cef-menu-tracking-test menu_tracking_test.cpp)
target_compile_features(cef-menu-tracking-test PRIVATE cxx_std_17)
add_test(NAME cef-menu-tracking COMMAND cef-menu-tracking-test)
add_executable(cef-tray-lifecycle-test tray_lifecycle_test.cpp)
target_compile_features(cef-tray-lifecycle-test PRIVATE cxx_std_17)
add_test(NAME cef-tray-lifecycle COMMAND cef-tray-lifecycle-test)
add_executable(cef-chrome-theme-test chrome_theme_test.cpp)
target_compile_features(cef-chrome-theme-test PRIVATE cxx_std_17)
add_test(NAME cef-chrome-theme COMMAND cef-chrome-theme-test)
add_executable(cef-pet-geometry-test pet_geometry_test.cpp)
target_compile_features(cef-pet-geometry-test PRIVATE cxx_std_17)
add_test(NAME cef-pet-geometry COMMAND cef-pet-geometry-test)
add_executable(cef-popup-layout-test popup_layout_test.cpp)
target_compile_features(cef-popup-layout-test PRIVATE cxx_std_17)
add_test(NAME cef-popup-layout COMMAND cef-popup-layout-test)
add_executable(cef-pet-chat-state-test pet_chat_state_test.cpp)
target_compile_features(cef-pet-chat-state-test PRIVATE cxx_std_17)
add_test(NAME cef-pet-chat-state COMMAND cef-pet-chat-state-test)
add_executable(cef-pet-input-policy-test pet_input_policy_test.cpp)
target_compile_features(cef-pet-input-policy-test PRIVATE cxx_std_17)
add_test(NAME cef-pet-input-policy COMMAND cef-pet-input-policy-test)

# Generate the same embedded compatibility script for portable byte-identity
# tests and the Windows host. Each raw literal stays below MSVC's token limit.
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/vendor/popover.iife.min.js")
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/vendor/popover.iife.min.js" KEEPWORK_POPOVER_SCRIPT)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/session_popovers.js")
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/session_popovers.js" KEEPWORK_SESSION_POPOVERS_SCRIPT)
configure_file(compatibility_script.h.in compatibility_script.h @ONLY NEWLINE_STYLE UNIX)
add_executable(cef-embedded-script-test embedded_script_test.cpp)
target_compile_features(cef-embedded-script-test PRIVATE cxx_std_17)
target_include_directories(cef-embedded-script-test PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")
if(MSVC)
  target_compile_options(cef-embedded-script-test PRIVATE /utf-8)
endif()
add_test(NAME cef-embedded-script COMMAND cef-embedded-script-test "${CMAKE_CURRENT_BINARY_DIR}/compiled-compatibility-script.js")
if(KEEPWORK_POLICY_TESTS_ONLY)
  return()
endif()

if(NOT WIN32 OR NOT MSVC)
  message(FATAL_ERROR "Build the CEF host on Windows with MSVC/clang-cl and the matching CEF SDK")
endif()
enable_language(RC)
if(NOT IS_DIRECTORY "${CEF_ROOT}" OR NOT EXISTS "${CEF_ROOT}/include/cef_version.h")
  message(FATAL_ERROR "CEF_ROOT must point to a verified, extracted Windows CEF binary distribution")
endif()
get_filename_component(CEF_ROOT "${CEF_ROOT}" ABSOLUTE)
file(READ "${CEF_ROOT}/include/cef_version.h" version_header)
string(REGEX MATCH "#define CEF_VERSION_MAJOR ([0-9]+)" major_match "${version_header}")
set(KEEPWORK_CEF_MAJOR "${CMAKE_MATCH_1}")
string(REGEX MATCH "#define CEF_VERSION \"([^\"]+)\"" version_match "${version_header}")
set(KEEPWORK_CEF_VERSION "${CMAKE_MATCH_1}")
if(NOT KEEPWORK_CEF_MAJOR STREQUAL "109" AND KEEPWORK_CEF_MAJOR LESS 138)
  message(FATAL_ERROR "Supported lines are legacy CEF 109 and modern CEF 138+; select a verified current modern SDK")
endif()
if(NOT KEEPWORK_CEF_VERSION OR NOT KEEPWORK_CEF_MAJOR)
  message(FATAL_ERROR "Could not read CEF SDK version")
endif()

# Do not offer an unsandboxed build variant. For M138+ the official bootstrap
# executable provides the broker compiled with Chromium's own toolchain.
if(DEFINED USE_SANDBOX AND NOT USE_SANDBOX)
  message(FATAL_ERROR "Keepwork CEF requires USE_SANDBOX=ON")
endif()
set(USE_SANDBOX ON CACHE BOOL "Required Chromium process sandbox" FORCE)
set(USE_ATL OFF CACHE BOOL "No ATL dependency" FORCE)
# Some CEF SDKs prefer the host's CPU over the compiler's target when this is
# omitted (notably cross-builds from ARM64 Windows). Select the target explicitly.
if(NOT DEFINED PROJECT_ARCH)
  if(CMAKE_GENERATOR_PLATFORM STREQUAL "ARM64" OR
     CMAKE_CXX_COMPILER_ARCHITECTURE_ID STREQUAL "ARM64")
    set(PROJECT_ARCH arm64)
  elseif(CMAKE_SIZEOF_VOID_P EQUAL 8)
    set(PROJECT_ARCH x86_64)
  else()
    set(PROJECT_ARCH x86)
  endif()
endif()
if(NOT PROJECT_ARCH MATCHES "^(x86|x86_64|arm64)$")
  message(FATAL_ERROR "Unsupported Windows CEF target architecture")
endif()
list(APPEND CMAKE_MODULE_PATH "${CEF_ROOT}/cmake")
find_package(CEF REQUIRED)
add_subdirectory("${CEF_LIBCEF_DLL_WRAPPER_PATH}" libcef_dll_wrapper)
ADD_LOGICAL_TARGET(libcef_lib "${CEF_LIB_DEBUG}" "${CEF_LIB_RELEASE}")

set(CEF_TARGET keepwork-cef)
set(CEF_TARGET_OUT_DIR "${CMAKE_BINARY_DIR}/payload/$<CONFIG>")
configure_file(keepwork-cef.rc.in keepwork-cef.rc @ONLY)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/../../src/chromeTheme.js")
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/../../src/chromeTheme.js" KEEPWORK_CHROME_THEME_SCRIPT)
string(REPLACE "export function mountDesktopTheme" "function mountDesktopTheme" KEEPWORK_CHROME_THEME_SCRIPT "${KEEPWORK_CHROME_THEME_SCRIPT}")
configure_file(theme_script.h.in theme_script.h @ONLY)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/pet_bridge.js")
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/pet_bridge.js" KEEPWORK_PET_BRIDGE_SCRIPT)
configure_file(pet_script.h.in pet_script.h @ONLY)
if(KEEPWORK_CEF_MAJOR GREATER_EQUAL 138)
  if(NOT EXISTS "${CEF_ROOT}/Release/bootstrap.exe")
    message(FATAL_ERROR "The modern SDK must include Release/bootstrap.exe for sandboxed startup")
  endif()
  add_library(${CEF_TARGET} SHARED main.cpp "${CMAKE_CURRENT_BINARY_DIR}/keepwork-cef.rc")
  SET_LIBRARY_TARGET_PROPERTIES(${CEF_TARGET})
  target_compile_features(${CEF_TARGET} PRIVATE cxx_std_20)
  target_compile_definitions(${CEF_TARGET} PRIVATE CEF_USE_BOOTSTRAP)
  file(READ "${CEF_ROOT}/include/cef_sandbox_win.h" sandbox_header)
  if(sandbox_header MATCHES "cef_version_info_t")
    target_compile_definitions(${CEF_TARGET} PRIVATE KEEPWORK_CEF_BOOTSTRAP_VERSION_INFO)
  endif()
  set(KEEPWORK_SANDBOX bootstrap)
  add_custom_command(TARGET ${CEF_TARGET} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${CEF_BINARY_DIR}/bootstrap.exe" "${CEF_TARGET_OUT_DIR}/keepwork-cef.exe"
    VERBATIM)
  if(COMMAND SET_LPAC_ACLS)
    SET_LPAC_ACLS(${CEF_TARGET})
  endif()
else()
  if(NOT EXISTS "${CEF_ROOT}/Release/cef_sandbox.lib")
    message(FATAL_ERROR "The CEF 109 SDK must include Release/cef_sandbox.lib")
  endif()
  add_executable(${CEF_TARGET} WIN32 main.cpp "${CMAKE_CURRENT_BINARY_DIR}/keepwork-cef.rc")
  SET_EXECUTABLE_TARGET_PROPERTIES(${CEF_TARGET})
  target_compile_features(${CEF_TARGET} PRIVATE cxx_std_17)
  target_compile_definitions(${CEF_TARGET} PRIVATE CEF_USE_SANDBOX)
  target_link_options(${CEF_TARGET} PRIVATE /SUBSYSTEM:WINDOWS,6.01)
  ADD_LOGICAL_TARGET(cef_sandbox_lib "${CEF_SANDBOX_LIB_DEBUG}" "${CEF_SANDBOX_LIB_RELEASE}")
  target_link_libraries(${CEF_TARGET} PRIVATE cef_sandbox_lib ${CEF_SANDBOX_STANDARD_LIBS})
  set(KEEPWORK_SANDBOX cef_sandbox)
endif()
set_target_properties(${CEF_TARGET} PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CEF_TARGET_OUT_DIR}"
  LIBRARY_OUTPUT_DIRECTORY "${CEF_TARGET_OUT_DIR}")
target_link_libraries(${CEF_TARGET} PRIVATE libcef_lib libcef_dll_wrapper ${CEF_STANDARD_LIBS} shell32 gdiplus ole32 comctl32 imm32)
target_compile_options(${CEF_TARGET} PRIVATE /utf-8)
target_compile_definitions(${CEF_TARGET} PRIVATE UNICODE _UNICODE NOMINMAX)
target_include_directories(${CEF_TARGET} PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")

# Private native dictation companion. It reuses the Tauri client's ATVV/ASR
# implementation without linking Tauri or requiring a WebView2 installation.
# The CEF controller never launches it on Windows 7/8 (WinRT BLE is unavailable).
if(PROJECT_ARCH STREQUAL "x86_64")
  set(KEEPWORK_VOICE_TARGET x86_64-pc-windows-msvc)
elseif(PROJECT_ARCH STREQUAL "arm64")
  set(KEEPWORK_VOICE_TARGET aarch64-pc-windows-msvc)
else()
  set(KEEPWORK_VOICE_TARGET i686-pc-windows-msvc)
endif()
find_program(KEEPWORK_CARGO cargo REQUIRED)
set(KEEPWORK_VOICE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../remote-voice")
set(KEEPWORK_VOICE_OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/remote-voice-target/${KEEPWORK_VOICE_TARGET}/release/keepwork-remote-voice.exe")
file(GLOB KEEPWORK_VOICE_SHARED CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/../../src-tauri/src/remote_voice/*.rs")
add_custom_command(OUTPUT "${KEEPWORK_VOICE_OUTPUT}"
  COMMAND ${CMAKE_COMMAND} -E env "RUSTFLAGS=$ENV{RUSTFLAGS} -C target-feature=+crt-static"
    "${KEEPWORK_CARGO}" build --manifest-path "${KEEPWORK_VOICE_ROOT}/Cargo.toml"
    --target "${KEEPWORK_VOICE_TARGET}" --release --locked
    --target-dir "${CMAKE_CURRENT_BINARY_DIR}/remote-voice-target"
  DEPENDS "${KEEPWORK_VOICE_ROOT}/Cargo.toml" "${KEEPWORK_VOICE_ROOT}/Cargo.lock"
    "${KEEPWORK_VOICE_ROOT}/src/main.rs" "${CMAKE_CURRENT_SOURCE_DIR}/../../src-tauri/src/remote_voice.rs"
    ${KEEPWORK_VOICE_SHARED}
  VERBATIM)
add_custom_target(keepwork-remote-voice-build DEPENDS "${KEEPWORK_VOICE_OUTPUT}")
add_dependencies(${CEF_TARGET} keepwork-remote-voice-build)
add_custom_command(TARGET ${CEF_TARGET} POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different "${KEEPWORK_VOICE_OUTPUT}" "${CEF_TARGET_OUT_DIR}/keepwork-remote-voice.exe"
  VERBATIM)

COPY_FILES("${CEF_TARGET}" "${CEF_BINARY_FILES}" "${CEF_BINARY_DIR}" "${CEF_TARGET_OUT_DIR}")
COPY_FILES("${CEF_TARGET}" "${CEF_RESOURCE_FILES}" "${CEF_RESOURCE_DIR}" "${CEF_TARGET_OUT_DIR}")

file(READ "${CMAKE_CURRENT_SOURCE_DIR}/../../package.json" app_package)
string(JSON KEEPWORK_HOST_VERSION GET "${app_package}" version)
configure_file(host_version.h.in host_version.h @ONLY)
if(PROJECT_ARCH STREQUAL "x86_64")
  set(KEEPWORK_HOST_ARCH x64)
elseif(PROJECT_ARCH STREQUAL "arm64")
  set(KEEPWORK_HOST_ARCH arm64)
else()
  set(KEEPWORK_HOST_ARCH x86)
endif()
if(KEEPWORK_CEF_MAJOR STREQUAL "109" AND KEEPWORK_HOST_ARCH STREQUAL "arm64")
  message(FATAL_ERROR "The Windows 7 legacy channel supports x86 and x64 only")
endif()
configure_file(cef-host.json.in cef-host.json @ONLY)
add_custom_command(TARGET ${CEF_TARGET} POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    "${CMAKE_CURRENT_BINARY_DIR}/cef-host.json" "${CEF_TARGET_OUT_DIR}/cef-host.json"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    "${CEF_ROOT}/LICENSE.txt" "${CEF_TARGET_OUT_DIR}/CEF-LICENSE.txt"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    "${CMAKE_CURRENT_SOURCE_DIR}/vendor/LICENSE.txt" "${CEF_TARGET_OUT_DIR}/popover-polyfill-LICENSE.txt"
  VERBATIM)

# The payload is a separate CDN artifact. Do not add it to Tauri resources or
# the bootstrap installer; doing so would bundle CEF with every installation.

# Real owner drawing on a private hidden window. Cross-builds compile this
# fixture; only a Windows execution verifies the GDI/WM_DRAWITEM adapter.
add_executable(cef-window-adapter-test window_adapter_test.cpp "${CMAKE_CURRENT_BINARY_DIR}/keepwork-cef.rc")
target_compile_features(cef-window-adapter-test PRIVATE cxx_std_17)
target_compile_options(cef-window-adapter-test PRIVATE /utf-8)
target_link_options(cef-window-adapter-test PRIVATE /MANIFEST:NO)
target_compile_definitions(cef-window-adapter-test PRIVATE UNICODE _UNICODE NOMINMAX WINVER=0x0601 _WIN32_WINNT=0x0601)
target_include_directories(cef-window-adapter-test PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")
target_link_libraries(cef-window-adapter-test PRIVATE user32 gdi32 shell32 gdiplus ole32 comctl32 imm32)
add_test(NAME cef-window-adapter COMMAND cef-window-adapter-test)

add_executable(cef-pet-chat-panel-test pet_chat_panel_test.cpp "${CMAKE_CURRENT_BINARY_DIR}/keepwork-cef.rc")
target_compile_features(cef-pet-chat-panel-test PRIVATE cxx_std_17)
target_compile_options(cef-pet-chat-panel-test PRIVATE /utf-8 /EHsc)
target_link_options(cef-pet-chat-panel-test PRIVATE /MANIFEST:NO)
target_compile_definitions(cef-pet-chat-panel-test PRIVATE UNICODE _UNICODE NOMINMAX WINVER=0x0601 _WIN32_WINNT=0x0601)
target_link_libraries(cef-pet-chat-panel-test PRIVATE user32 gdi32 shell32 gdiplus ole32 comctl32 imm32)
add_test(NAME cef-pet-chat-panel COMMAND cef-pet-chat-panel-test)

!define KEEPWORK_INSTALLER_HOOK_DIR "${__FILEDIR__}"

!macro KEEPWORK_STOP_BUNDLED_MCP
  Push $0
  Push $1
  InitPluginsDir
  File "/oname=$PLUGINSDIR\stop-mcp.ps1" "${KEEPWORK_INSTALLER_HOOK_DIR}\stop-mcp.ps1"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-mcp.ps1" -InstallDir "$INSTDIR"'
  Pop $0
  Pop $1
  ${If} $0 != "0"
    DetailPrint "$1"
    SetErrorLevel 2
    Abort "Unable to stop Keepwork MCP. Quit Keepwork and retry."
  ${EndIf}
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Stop the supervisor first so it cannot restart MCP during file replacement.
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  !insertmacro KEEPWORK_STOP_BUNDLED_MCP
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  !insertmacro KEEPWORK_STOP_BUNDLED_MCP
!macroend

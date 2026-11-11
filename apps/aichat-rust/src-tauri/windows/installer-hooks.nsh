!macro KEEPWORK_STOP_BUNDLED_MCP
  Push $0
  Push $1
  ; Use this release's helper mode, including when upgrading an older app
  ; without that command. It verifies executable paths and retains handles.
  InitPluginsDir
  File /oname=$PLUGINSDIR\keepwork-installer-helper.exe "${MAINBINARYSRCPATH}"
  nsExec::ExecToStack '"$PLUGINSDIR\keepwork-installer-helper.exe" --stop-mcp "$INSTDIR"'
  Pop $0
  Pop $1
  ${If} $0 != "0"
    DetailPrint "$1"
    SetErrorLevel 2
    Abort "Unable to stop bundled Keepwork MCP. Quit Keepwork and retry."
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

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

!macro NSIS_HOOK_POSTINSTALL
  ; A current-user protocol starts only this verified installation, directly.
  ; The Rust parser accepts two exact actions and never invokes a shell.
  WriteRegStr HKCU "Software\Classes\keepwork-secondbrain" "" "URL:Keepwork Second Brain"
  WriteRegStr HKCU "Software\Classes\keepwork-secondbrain" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\keepwork-secondbrain\shell\open\command" "" '$"$INSTDIR\${MAINBINARYNAME}.exe$" --launch-url $"%1$"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Another edition/installation may now own this shared URL scheme.
  Push $0
  ReadRegStr $0 HKCU "Software\Classes\keepwork-secondbrain\shell\open\command" ""
  ${If} $0 == '$"$INSTDIR\${MAINBINARYNAME}.exe$" --launch-url $"%1$"'
    DeleteRegKey HKCU "Software\Classes\keepwork-secondbrain"
  ${EndIf}
  Pop $0
!macroend

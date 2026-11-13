!include FileFunc.nsh

!macro KEEPWORK_RECORD_UPDATE_RESULT state
  Push $0
  Push $1
  ${GetOptions} $CMDLINE "/KEEPWORK_PARENT=" $0
  ${If} ${Errors}
    ; A downloaded package can be retried manually without the parent flag.
    ; Complete its existing receipt, including a previous handoff failure.
    StrCpy $0 0
    IfFileExists "$EXEPATH.result.json" 0 +2
      StrCpy $0 1
    IfFileExists "$EXEDIR\desktop-install-error.json" 0 +2
      StrCpy $0 1
  ${Else}
    StrCpy $0 1
  ${EndIf}
  ${If} $0 == 1
    ClearErrors
    FileOpen $1 "$EXEPATH.result.json" w
    ${IfNot} ${Errors}
      ; ASCII JSON is UTF-8 and readable even when NSIS uses another code page.
      FileWrite $1 '{"state":"${state}","code":"nsis-${state}"}'
      FileClose $1
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
!macroend

Function .onInstFailed
  !insertmacro KEEPWORK_RECORD_UPDATE_RESULT "failed"
FunctionEnd

; The pinned Tauri template's default check uses RmForceShutdown in silent
; mode. Replace it with a path-scoped, fail-closed check for BOTH the template
; call and our hooks: a reopened app must abort updating, never be killed.
!macroundef CheckIfAppIsRunning
!macro CheckIfAppIsRunning executablePath productName
  Push $0
  Push $1
  InitPluginsDir
  File /oname=$PLUGINSDIR\keepwork-installer-helper.exe "${MAINBINARYSRCPATH}"
  nsExec::ExecToStack '"$PLUGINSDIR\keepwork-installer-helper.exe" --check-desktop-stopped "${executablePath}"'
  Pop $0
  Pop $1
  ${If} $0 != "0"
    DetailPrint "$1"
    SetErrorLevel 2
    Abort "Quit ${productName} before installing an update. The update package has been retained."
  ${EndIf}
  Pop $1
  Pop $0
!macroend

!macro KEEPWORK_WAIT_UPDATE_PARENT
  Push $0
  Push $1
  Push $2
  ${GetOptions} $CMDLINE "/KEEPWORK_PARENT=" $0
  ${IfNot} ${Errors}
    ${GetOptions} $CMDLINE "/KEEPWORK_EXE=" $2
    ${If} $2 != "Keepwork.exe"
    ${AndIf} $2 != "aichat-rust.exe"
      SetErrorLevel 2
      Abort "Invalid update parent executable"
    ${EndIf}
    InitPluginsDir
    File /oname=$PLUGINSDIR\keepwork-installer-helper.exe "${MAINBINARYSRCPATH}"
    nsExec::ExecToStack '"$PLUGINSDIR\keepwork-installer-helper.exe" --wait-for-desktop "$0" "$INSTDIR\$2"'
    Pop $0
    Pop $1
    ${If} $0 != "0"
      DetailPrint "$1"
      SetErrorLevel 2
      Abort "Unable to wait for Keepwork to exit. The update package has been retained."
    ${EndIf}
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
!macroend

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
  !insertmacro KEEPWORK_RECORD_UPDATE_RESULT "installing"
  !insertmacro KEEPWORK_WAIT_UPDATE_PARENT
  ; Older releases used the other native name. A restarted legacy app must
  ; block replacement too, without terminating it or its bundled MCP.
  !insertmacro CheckIfAppIsRunning "$INSTDIR\Keepwork.exe" "${PRODUCTNAME}"
  !insertmacro CheckIfAppIsRunning "$INSTDIR\aichat-rust.exe" "${PRODUCTNAME}"
  !insertmacro KEEPWORK_STOP_BUNDLED_MCP
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CheckIfAppIsRunning "$INSTDIR\Keepwork.exe" "${PRODUCTNAME}"
  !insertmacro CheckIfAppIsRunning "$INSTDIR\aichat-rust.exe" "${PRODUCTNAME}"
  !insertmacro KEEPWORK_STOP_BUNDLED_MCP
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; A current-user protocol starts only this verified installation, directly.
  ; The Rust parser accepts two exact actions and never invokes a shell.
  WriteRegStr HKCU "Software\Classes\keepwork-secondbrain" "" "URL:Keepwork Second Brain"
  WriteRegStr HKCU "Software\Classes\keepwork-secondbrain" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\keepwork-secondbrain\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" --launch-url "%1"'
  !insertmacro KEEPWORK_RECORD_UPDATE_RESULT "installed"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Another edition/installation may now own this shared URL scheme.
  Push $0
  ReadRegStr $0 HKCU "Software\Classes\keepwork-secondbrain\shell\open\command" ""
  ${If} $0 S== '"$INSTDIR\${MAINBINARYNAME}.exe" --launch-url "%1"'
    DeleteRegKey HKCU "Software\Classes\keepwork-secondbrain"
  ${EndIf}
  Pop $0
!macroend

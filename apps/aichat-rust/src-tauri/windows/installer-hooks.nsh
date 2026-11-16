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

; A new installer/uninstaller process owns its own variables and $PLUGINSDIR.
; Never overwrite the helper after it has run: its image (or an antivirus scan)
; may still hold the file even after nsExec reports that the process exited.
Var KeepworkInstallerHelperReady
!macro KEEPWORK_PREPARE_INSTALLER_HELPER
  InitPluginsDir
  ${If} $KeepworkInstallerHelperReady != "1"
    ClearErrors
    ; Handle write failures ourselves; the default File UI offers Ignore,
    ; which must never bypass the process cleanup required before replacement.
    SetOverwrite try
    File /oname=$PLUGINSDIR\keepwork-installer-helper.exe "${MAINBINARYSRCPATH}"
    SetOverwrite lastused
    ${If} ${Errors}
      DetailPrint "无法解压安装辅助程序：$PLUGINSDIR\keepwork-installer-helper.exe"
      DetailPrint "可能原因：文件被占用、临时目录权限或空间不足，或安全软件拦截。请检查后重新运行安装包。"
      MessageBox MB_ICONSTOP|MB_OK "无法写入安装辅助程序：$\r$\n$PLUGINSDIR\keepwork-installer-helper.exe$\r$\n$\r$\n可能原因：文件被占用、临时目录权限或空间不足，或安全软件拦截。请检查临时目录可用空间和安全软件提示后重新运行安装包。$\r$\n安装或卸载已中止，安装包已保留。" /SD IDOK
      SetErrorLevel 2
      Abort "无法解压安装辅助程序，安装或卸载已中止；请查看上方中文错误详情。"
    ${EndIf}
    ; Only a completed extraction is reusable. A partial file is never ready.
    StrCpy $KeepworkInstallerHelperReady "1"
  ${EndIf}
!macroend

; All commands use this release's helper, even when the installed release is
; older. A UTF-16LE file avoids nsExec's system-code-page decoding of UTF-8.
!macro KEEPWORK_RUN_INSTALLER_HELPER arguments
  Push $0
  Push $1
  Push $2
  !insertmacro KEEPWORK_PREPARE_INSTALLER_HELPER
  Delete "$PLUGINSDIR\keepwork-installer-error.txt"
  nsExec::ExecToStack '"$PLUGINSDIR\keepwork-installer-helper.exe" ${arguments} --error-file "$PLUGINSDIR\keepwork-installer-error.txt"'
  Pop $0
  Pop $1
  ${If} $0 != "0"
    ; Launch failures have no helper report. Do not show undecodable pipe text.
    StrCpy $1 "安装辅助程序异常退出（退出码 $0）；请完全退出 Keepwork 后重试。"
    ${If} $0 == "error"
      StrCpy $1 "无法启动安装辅助程序，可能被安全软件拦截或安装包损坏；请检查安全软件提示并重新下载安装包。"
    ${ElseIf} $0 == "timeout"
      StrCpy $1 "安装辅助程序等待超时；请从托盘完全退出 Keepwork 后重试。"
    ${EndIf}
    ClearErrors
    FileOpen $2 "$PLUGINSDIR\keepwork-installer-error.txt" r
    ${IfNot} ${Errors}
      FileReadUTF16LE $2 $0
      FileClose $2
      ${If} $0 != ""
        StrCpy $1 $0
      ${EndIf}
    ${EndIf}
    DetailPrint "$1"
    MessageBox MB_ICONSTOP|MB_OK "$1$\r$\n$\r$\n安装或卸载已中止，安装包已保留。" /SD IDOK
    SetErrorLevel 2
    Abort "$1"
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
  ClearErrors
!macroend

; Replace the template's running-app check with a path-scoped stop.
!macroundef CheckIfAppIsRunning
!macro CheckIfAppIsRunning executablePath productName
  !insertmacro KEEPWORK_RUN_INSTALLER_HELPER '--stop-desktop "${executablePath}"'
!macroend

; Called by the vendored maintenance-page template only AFTER the user chooses
; to uninstall. The old installed uninstaller may only check and refuse to stop.
!macro KEEPWORK_PREPARE_OLD_UNINSTALL installDir
  ${If} "${installDir}" == ""
    MessageBox MB_ICONSTOP|MB_OK "无法确认旧版 Keepwork 的安装目录，已中止卸载。请从系统设置中卸载旧版后重试。" /SD IDOK
    Abort "无法确认旧版 Keepwork 的安装目录，已中止卸载。"
  ${EndIf}
  !insertmacro KEEPWORK_RUN_INSTALLER_HELPER '--stop-desktop "${installDir}\Keepwork.exe"'
  !insertmacro KEEPWORK_RUN_INSTALLER_HELPER '--stop-desktop "${installDir}\aichat-rust.exe"'
  !insertmacro KEEPWORK_RUN_INSTALLER_HELPER '--stop-mcp "${installDir}"'
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
      Abort "更新父进程的程序名无效，已中止更新。"
    ${EndIf}
    !insertmacro KEEPWORK_RUN_INSTALLER_HELPER '--wait-for-desktop "$0" "$INSTDIR\$2"'
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro KEEPWORK_STOP_BUNDLED_MCP
  !insertmacro KEEPWORK_RUN_INSTALLER_HELPER '--stop-mcp "$INSTDIR"'
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Stop the supervisor first so it cannot restart MCP during file replacement.
  !insertmacro KEEPWORK_RECORD_UPDATE_RESULT "installing"
  !insertmacro KEEPWORK_WAIT_UPDATE_PARENT
  ; Stop either native name, including an app reopened during the handoff.
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

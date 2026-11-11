Unicode true
RequestExecutionLevel user
Name "Keepwork 兼容版"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\KeepworkCompatible"
InstallDirRegKey HKCU "Software\Keepwork\Compatible" "InstallDir"
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "WinVer.nsh"
!include "x64.nsh"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${AtLeastWin7}
    MessageBox MB_ICONSTOP "Keepwork 兼容版需要 Windows 7 SP1 或更新系统。"
    Abort
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "此安装包需要 64 位 Windows。"
    Abort
  ${EndIf}
!if "${ARCH}" == "arm64"
  ${IfNot} ${IsNativeARM64}
    MessageBox MB_ICONSTOP "此安装包仅适用于 ARM64 Windows。"
    Abort
  ${EndIf}
!else
  ${If} ${IsNativeARM64}
    MessageBox MB_ICONSTOP "请使用 ARM64 版本的 Keepwork 兼容安装包。"
    Abort
  ${EndIf}
!endif
FunctionEnd

Section "Keepwork"
  SetShellVarContext current
  InitPluginsDir
  File /oname=$PLUGINSDIR\keepwork-bootstrap-helper.exe "${PAYLOAD}\Keepwork.exe"
  nsExec::ExecToStack '"$PLUGINSDIR\keepwork-bootstrap-helper.exe" --check-install-idle "$INSTDIR"'
  Pop $0
  Pop $1
  ${If} $0 != "0"
    MessageBox MB_ICONSTOP "请完全退出 Keepwork（包括兼容窗口）后重试安装。"
    Abort
  ${EndIf}
  ; Do not run the modern Rust helper on Windows 7/8. CEF mode starts no MCP.
  ${If} ${AtLeastWin10}
    InitPluginsDir
    File /oname=$PLUGINSDIR\keepwork-installer-helper.exe "${PAYLOAD}\aichat-rust.exe"
    nsExec::ExecToStack '"$PLUGINSDIR\keepwork-installer-helper.exe" --stop-mcp "$INSTDIR"'
    Pop $0
    Pop $1
    ${If} $0 != "0"
      MessageBox MB_ICONSTOP "请完全退出 Keepwork 后重试。$\r$\n$1"
      Abort
    ${EndIf}
  ${EndIf}
  ; File replacement fails visibly if the app is still running. Never kill by process name.
  SetOverwrite on
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD}\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Keepwork"
  CreateShortcut "$SMPROGRAMS\Keepwork\Keepwork 兼容版.lnk" "$INSTDIR\Keepwork.exe"
  WriteRegStr HKCU "Software\Keepwork\Compatible" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KeepworkCompatible" "DisplayName" "Keepwork 兼容版"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KeepworkCompatible" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KeepworkCompatible" "UninstallString" '$"$INSTDIR\Uninstall.exe$"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KeepworkCompatible" "InstallLocation" "$INSTDIR"
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  nsExec::ExecToStack '"$INSTDIR\Keepwork.exe" --check-install-idle "$INSTDIR"'
  Pop $0
  Pop $1
  ${If} $0 != "0"
    MessageBox MB_ICONSTOP "请完全退出 Keepwork（包括兼容窗口）后重试卸载。"
    Abort
  ${EndIf}
  ${If} ${AtLeastWin10}
    nsExec::ExecToStack '"$INSTDIR\aichat-rust.exe" --stop-mcp "$INSTDIR"'
    Pop $0
    Pop $1
    ${If} $0 != "0"
      MessageBox MB_ICONSTOP "请完全退出 Keepwork 后重试卸载。"
      Abort
    ${EndIf}
  ${EndIf}
  Delete "$SMPROGRAMS\Keepwork\Keepwork 兼容版.lnk"
  RMDir "$SMPROGRAMS\Keepwork"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Keepwork\Compatible"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KeepworkCompatible"
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "KeepworkAIChatDesktop"
  StrCmp $0 '$"$INSTDIR\Keepwork.exe$" --background' 0 +2
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "KeepworkAIChatDesktop"
  ; Keep browser profiles, conversations and verified downloads in LocalAppData.
SectionEnd

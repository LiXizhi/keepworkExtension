Unicode true
RequestExecutionLevel user
Name "Keepwork Windows 7 / 8 专版"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\KeepworkWin7Win8"
InstallDirRegKey HKCU "Software\Keepwork\Win7Win8" "InstallDir"
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
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Keepwork Windows 7 and 8"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Keepwork"
VIAddVersionKey "FileDescription" "Keepwork Windows 7 SP1 / 8 / 8.1 x64 compatibility edition"
Var IdleRetries

Function .onInit
  ${IfNot} ${AtLeastWin7}
    MessageBox MB_ICONSTOP "此版本需要 Windows 7 SP1 / Windows 8 / Windows 8.1 x64 或更新的系统。"
    Abort
  ${EndIf}
  ${If} ${IsWin7}
  ${AndIfNot} ${AtLeastServicePack} 1
    MessageBox MB_ICONSTOP "请先安装 Windows 7 Service Pack 1。"
    Abort
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "此安装包需要 64 位 Windows，不支持 32 位 Windows。"
    Abort
  ${EndIf}
  ${If} ${IsNativeARM64}
    MessageBox MB_ICONSTOP "此安装包适用于 x64，不适用于 ARM64。"
    Abort
  ${EndIf}
FunctionEnd

Section "Keepwork Windows 7 and 8"
  SetShellVarContext current
  InitPluginsDir
  File /oname=$PLUGINSDIR\keepwork-win7-helper.exe "${PAYLOAD}\Keepwork.exe"
  ; --update-client starts this installer and then exits. Wait only for the UI
  ; and launcher; the independently cached MCP daemon remains alive.
  StrCpy $IdleRetries 0
  win7_idle_retry:
    nsExec::ExecToStack '"$PLUGINSDIR\keepwork-win7-helper.exe" --check-install-idle "$INSTDIR"'
    Pop $0
    Pop $1
    ${If} $0 != "0"
      IntOp $IdleRetries $IdleRetries + 1
      ${If} $IdleRetries < 20
        Sleep 250
        Goto win7_idle_retry
      ${EndIf}
      MessageBox MB_ICONSTOP "请关闭 Keepwork 窗口和兼容启动器后重试；本地 MCP 服务无需停止。"
      Abort
    ${EndIf}
  SetOutPath "$INSTDIR"
  SetOverwrite on
  File /r "${PAYLOAD}\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Keepwork Windows 7 and 8"
  CreateShortcut "$SMPROGRAMS\Keepwork Windows 7 and 8\Keepwork.lnk" "$INSTDIR\Keepwork.exe"
  CreateShortcut "$SMPROGRAMS\Keepwork Windows 7 and 8\检查客户端更新.lnk" "$INSTDIR\Keepwork.exe" "--update-client"
  CreateShortcut "$SMPROGRAMS\Keepwork Windows 7 and 8\准备本地服务更新.lnk" "$INSTDIR\Keepwork.exe" "--update-mcp"
  WriteRegStr HKCU "Software\Keepwork\Win7Win8" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KeepworkWin7Win8" "DisplayName" "Keepwork Windows 7 / 8 专版"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KeepworkWin7Win8" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KeepworkWin7Win8" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KeepworkWin7Win8" "UninstallString" '"$INSTDIR\Uninstall.exe"'
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  nsExec::ExecToStack '"$INSTDIR\Keepwork.exe" --check-install-idle "$INSTDIR"'
  Pop $0
  Pop $1
  ${If} $0 != "0"
    MessageBox MB_ICONSTOP "请先关闭 Keepwork 窗口和兼容启动器。"
    Abort
  ${EndIf}
  Delete "$SMPROGRAMS\Keepwork Windows 7 and 8\Keepwork.lnk"
  Delete "$SMPROGRAMS\Keepwork Windows 7 and 8\检查客户端更新.lnk"
  Delete "$SMPROGRAMS\Keepwork Windows 7 and 8\准备本地服务更新.lnk"
  RMDir "$SMPROGRAMS\Keepwork Windows 7 and 8"
  Delete "$INSTDIR\Keepwork.exe"
  Delete "$INSTDIR\win7-edition.json"
  Delete "$INSTDIR\resources\win7-mcp.signed.json"
  Delete "$INSTDIR\resources\cef-bundled.signed.json"
  Delete "$INSTDIR\resources\cef-bundled.zip"
  Delete "$INSTDIR\resources\win7-mcp\bin\keepwork-mcp.exe"
  Delete "$INSTDIR\resources\win7-mcp\runtime.json"
  Delete "$INSTDIR\resources\win7-mcp\LICENSE"
  RMDir "$INSTDIR\resources\win7-mcp\bin"
  RMDir "$INSTDIR\resources\win7-mcp"
  RMDir "$INSTDIR\resources"
  Delete "$INSTDIR\licenses\nlohmann-json-LICENSE.txt"
  Delete "$INSTDIR\licenses\miniz-LICENSE.txt"
  RMDir "$INSTDIR\licenses"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\Keepwork\Win7Win8"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KeepworkWin7Win8"
  ; Preserve .keepwork-mcp, verified runtime caches, profiles and user files.
SectionEnd

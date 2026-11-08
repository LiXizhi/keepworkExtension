Unicode true
RequestExecutionLevel user
Name "Keepwork Desktop"
OutFile "Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\Keepwork Desktop"
SetCompressor /SOLID lzma
!include "MUI2.nsh"
!include "LogicLib.nsh"
!define APPKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\KeepworkDesktopLauncher"
!define MUI_ICON "launcher.ico"
!define MUI_UNICON "launcher.ico"
!define MUI_WELCOMEFINISHPAGE_BITMAP "welcome.bmp"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "$(WelcomeTitle)"
!define MUI_WELCOMEPAGE_TEXT "$(WelcomeText)"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "$(FinishTitle)"
!define MUI_FINISHPAGE_TEXT "$(FinishText)"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"
LangString WelcomeTitle ${LANG_ENGLISH} "Install Keepwork Desktop"
LangString WelcomeTitle ${LANG_SIMPCHINESE} "安装 Keepwork 桌面版"
LangString WelcomeText ${LANG_ENGLISH} "Setup installs Keepwork for your Windows account and adds it to the Start menu.$\r$\n$\r$\nLocation: $INSTDIR$\r$\n$\r$\nThe first launch downloads the runtime. Existing conversations and settings are preserved."
LangString WelcomeText ${LANG_SIMPCHINESE} "将在当前 Windows 账户中安装 Keepwork，并添加到开始菜单。$\r$\n$\r$\n安装位置：$INSTDIR$\r$\n$\r$\n首次启动将下载运行时。已有对话和设置将保留。"
LangString FinishTitle ${LANG_ENGLISH} "Keepwork is installed"
LangString FinishTitle ${LANG_SIMPCHINESE} "Keepwork 已安装"
LangString FinishText ${LANG_ENGLISH} "Select Finish to open Keepwork. Next time, open Keepwork Desktop from the Start menu."
LangString FinishText ${LANG_SIMPCHINESE} "点击“完成”打开 Keepwork。以后可以从开始菜单启动 Keepwork Desktop。"
Section
 SetShellVarContext current
 IfFileExists "$INSTDIR\Keepwork.exe" 0 owned
 ReadRegStr $1 HKCU "${APPKEY}" "InstallLocation"
 StrCmp $1 "$INSTDIR" owned
 SetErrorLevel 2
 Abort "An existing application already uses this folder."
 owned:
 SetOutPath "$INSTDIR"
 ReadEnvStr $0 KEEPWORK_SETUP_SOURCE
 ClearErrors
 System::Call 'kernel32::CopyFileW(w r0, w "$INSTDIR\Keepwork.installing.exe", i 0)i.r1'
 IntCmp $1 0 failed
 System::Call 'kernel32::MoveFileExW(w "$INSTDIR\Keepwork.installing.exe", w "$INSTDIR\Keepwork.exe", i 9)i.r1'
 IntCmp $1 0 failed
 WriteUninstaller "$INSTDIR\Uninstall.exe"
 CreateShortcut "$SMPROGRAMS\Keepwork Desktop.lnk" "$INSTDIR\Keepwork.exe" "" "$INSTDIR\Keepwork.exe"
 WriteRegStr HKCU "${APPKEY}" "DisplayName" "Keepwork Desktop"
 WriteRegStr HKCU "${APPKEY}" "Publisher" "Keepwork"
 WriteRegStr HKCU "${APPKEY}" "DisplayIcon" "$INSTDIR\Keepwork.exe,0"
 WriteRegStr HKCU "${APPKEY}" "InstallLocation" "$INSTDIR"
 WriteRegStr HKCU "${APPKEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
 WriteRegDWORD HKCU "${APPKEY}" "NoModify" 1
 WriteRegDWORD HKCU "${APPKEY}" "NoRepair" 1
 Goto done
 failed:
 Delete "$INSTDIR\Keepwork.installing.exe"
 SetErrorLevel 2
 Abort "Unable to install the launcher. Close Keepwork Setup and retry."
 done:
SectionEnd
Section "Uninstall"
 SetShellVarContext current
 ReadRegStr $1 HKCU "${APPKEY}" "InstallLocation"
 StrCmp $1 "$INSTDIR" +3
 SetErrorLevel 2
 Abort "Unexpected installation folder."
 Delete "$SMPROGRAMS\Keepwork Desktop.lnk"
 ClearErrors
 Delete "$INSTDIR\Keepwork.exe"
 IfErrors 0 +3
 SetErrorLevel 2
 Abort "Quit Keepwork and retry."
 Delete "$INSTDIR\Uninstall.exe"
 DeleteRegKey HKCU "${APPKEY}"
 RMDir "$INSTDIR"
SectionEnd

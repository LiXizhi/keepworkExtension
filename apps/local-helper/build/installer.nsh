!macro customUnInstall
  nsExec::ExecToLog '"$INSTDIR\KP Local Helper.exe" --uninstall'
  Sleep 4000
  nsExec::ExecToLog 'taskkill /IM "KP Local Helper.exe" /F'
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.keepwork.local-helper"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.keepwork.local-helper"
!macroend

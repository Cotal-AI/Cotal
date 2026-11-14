!define MUI_CUSTOMFUNCTION_ABORT CotalSetupAbort
!define COTAL_HOOK_DIR "${__FILEDIR__}"

Var CotalPrepared
Var CotalCopying
Var CotalCode
Var CotalMessage
Var CotalVersion

Function CotalSetupMessage
  FileOpen $0 "$LOCALAPPDATA\CotalSetup\message.txt" r
  IfErrors 0 +3
    StrCpy $CotalMessage "Setup could not verify background service safety. No update was authorized. Run cotal daemon start and retry setup."
    Return
  FileRead $0 $CotalMessage
  FileClose $0
FunctionEnd

Function CotalSetupRefused
  Call CotalSetupMessage
  DetailPrint "$CotalMessage"
  SetErrorLevel $CotalCode
  ${IfNot} ${Silent}
    MessageBox MB_ICONSTOP|MB_OK "$CotalMessage"
  ${EndIf}
  Quit
FunctionEnd

Function CotalSetupAbort
  ${If} $CotalPrepared = 1
  ${AndIf} $CotalCopying <> 1
    nsExec::ExecToLog /TIMEOUT=240000 '"$PLUGINSDIR\setup-node.exe" "$PLUGINSDIR\service-update.mjs" abort "$INSTDIR" "$CotalVersion"'
    Pop $CotalCode
  ${EndIf}
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  InitPluginsDir
  StrCpy $CotalVersion "${VERSION}"
  SetOutPath $PLUGINSDIR
  File /oname=service-update.mjs "${COTAL_HOOK_DIR}\service-update.mjs"
  File /oname=service-task.ps1 "${COTAL_HOOK_DIR}\service-task.ps1"
  !if "${ARCH}" == "x64"
    File /oname=setup-node.exe "${COTAL_HOOK_DIR}\..\binaries\node-x86_64-pc-windows-msvc.exe"
  !else
    !error "Review the installer service helper for this Windows architecture."
  !endif
  System::Call 'kernel32::SetEnvironmentVariable(t "COTAL_SETUP_ROOT", t "$INSTDIR")'
  System::Call 'kernel32::SetEnvironmentVariable(t "COTAL_SETUP_VERSION", t "${VERSION}")'
  nsExec::ExecToStack /TIMEOUT=40000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\service-task.ps1" -Action recover'
  Pop $CotalCode
  Pop $CotalMessage
  ${If} $CotalCode <> 0
    DetailPrint "$CotalMessage"
    SetErrorLevel 21
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP|MB_OK "$CotalMessage"
    ${EndIf}
    Quit
  ${EndIf}
  ${If} $CotalMessage == "finish$\r$\n"
  ${OrIf} $CotalMessage == "finish$\n"
    nsExec::ExecToLog /TIMEOUT=120000 '"$PLUGINSDIR\setup-node.exe" "$PLUGINSDIR\service-update.mjs" finish "$INSTDIR" "${VERSION}"'
    Pop $CotalCode
    ${If} $CotalCode <> 0
      Call CotalSetupRefused
    ${EndIf}
    StrCpy $CotalMessage "none"
  ${EndIf}
  ${If} $CotalMessage == "recover$\r$\n"
  ${OrIf} $CotalMessage == "recover$\n"
    StrCpy $CotalPrepared 1
  ${Else}
    cotal_prepare_retry:
    nsExec::ExecToLog /TIMEOUT=240000 '"$PLUGINSDIR\setup-node.exe" "$PLUGINSDIR\service-update.mjs" prepare "$INSTDIR" "${VERSION}"'
    Pop $CotalCode
    ${If} $CotalCode = 20
    ${AndIfNot} ${Silent}
      Call CotalSetupMessage
      MessageBox MB_ICONEXCLAMATION|MB_RETRYCANCEL "$CotalMessage" IDRETRY cotal_prepare_retry
      SetErrorLevel 20
      Quit
    ${EndIf}
    ${If} $CotalCode <> 0
      Call CotalSetupRefused
    ${EndIf}
    StrCpy $CotalPrepared 1
  ${EndIf}
  ; From here a failed copy keeps the task disabled. Rerunning setup owns recovery.
  StrCpy $CotalCopying 1
  SetOutPath $INSTDIR
!macroend

; Tauri's own functions set the bundle AppUserModelID on each shortcut.
!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToLog /TIMEOUT=120000 '"$PLUGINSDIR\setup-node.exe" "$PLUGINSDIR\service-update.mjs" finish "$INSTDIR" "${VERSION}"'
  Pop $CotalCode
  ${If} $CotalCode <> 0
    Call CotalSetupRefused
  ${EndIf}
  StrCpy $CotalPrepared 0
  ${If} $UpdateMode <> 1
  ${AndIf} $NoShortcutMode <> 1
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}
!macroend

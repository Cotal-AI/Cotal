!define MUI_CUSTOMFUNCTION_ABORT CotalSetupAbort
!define COTAL_HOOK_DIR "${__FILEDIR__}"

Var CotalPrepared
Var CotalCopying
Var CotalCode
Var CotalMessage
Var CotalVersion
Var CotalSetupMutex
Var CotalFresh

Function CotalSetupMessage
  FileOpen $0 "$LOCALAPPDATA\CotalSetup\message.txt" r
  IfErrors 0 +3
    StrCpy $CotalMessage "Setup could not verify background service safety. No update was authorized. Run cotal daemon start and retry setup."
    Return
  FileRead $0 $CotalMessage
  FileClose $0
FunctionEnd

Function CotalHelperExit
  ${If} $CotalCode == "timeout"
  ${OrIf} $CotalCode == "error"
    CreateDirectory "$LOCALAPPDATA\CotalSetup"
    FileOpen $0 "$LOCALAPPDATA\CotalSetup\result.json" w
    FileWrite $0 '{$\"schema$\":1,$\"outcome$\":$\"refused$\",$\"code$\":21,$\"message$\":$\"Setup helper did not complete. No success was confirmed. Run the installer again.$\",$\"activeAgents$\":0,$\"fromVersion$\":null,$\"toVersion$\":$\"$CotalVersion$\"}'
    FileClose $0
    FileOpen $0 "$LOCALAPPDATA\CotalSetup\message.txt" w
    FileWrite $0 "Setup helper did not complete. No success was confirmed. Run the installer again.$\r$\n"
    FileClose $0
    StrCpy $CotalCode "21"
  ${EndIf}
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
    nsExec::ExecToLog /TIMEOUT=360000 '"$PLUGINSDIR\setup-node.exe" "$PLUGINSDIR\service-update.mjs" abort "$INSTDIR" "$CotalVersion"'
    Pop $CotalCode
    Call CotalHelperExit
    ${If} $CotalCode != "0"
      Call CotalSetupMessage
      DetailPrint "$CotalMessage"
      SetErrorLevel $CotalCode
    ${EndIf}
    StrCpy $CotalPrepared 0
  ${EndIf}
FunctionEnd

Function .onInstFailed
  Call CotalSetupAbort
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  InitPluginsDir
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\CotalDesktopSetup") p .r0 ?e'
  StrCpy $CotalSetupMutex $0
  Pop $1
  ${If} $CotalSetupMutex = 0
  ${OrIf} $1 = 183
    SetErrorLevel 21
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP|MB_OK "Another Cotal setup is running. Wait for it to finish, then retry."
    ${EndIf}
    Quit
  ${EndIf}
  StrCpy $CotalVersion "${VERSION}"
  ${IfNot} ${FileExists} "$INSTDIR\cotal-desktop.exe"
  ${AndIfNot} ${FileExists} "$LOCALAPPDATA\CotalSetup\service-update.json"
  ${AndIfNot} ${FileExists} "$LOCALAPPDATA\Cotal\daemon\service-unit.json"
    StrCpy $CotalFresh 1
    Goto cotal_prepared
  ${EndIf}
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
  Call CotalHelperExit
  ${If} $CotalCode != "0"
    DetailPrint "$CotalMessage"
    SetErrorLevel 21
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP|MB_OK "$CotalMessage"
    ${EndIf}
    Quit
  ${EndIf}
  ${If} $CotalMessage == "recover$\r$\n"
  ${OrIf} $CotalMessage == "recover$\n"
    StrCpy $CotalPrepared 1
  ${Else}
    cotal_prepare_retry:
    nsExec::ExecToLog /TIMEOUT=360000 '"$PLUGINSDIR\setup-node.exe" "$PLUGINSDIR\service-update.mjs" prepare "$INSTDIR" "${VERSION}"'
    Pop $CotalCode
    Call CotalHelperExit
    ${If} $CotalCode == "20"
    ${AndIfNot} ${Silent}
      Call CotalSetupMessage
      MessageBox MB_ICONEXCLAMATION|MB_RETRYCANCEL "$CotalMessage" IDRETRY cotal_prepare_retry
      SetErrorLevel 20
      Quit
    ${EndIf}
    ${If} $CotalCode != "0"
      Call CotalSetupRefused
    ${EndIf}
    StrCpy $CotalPrepared 1
  ${EndIf}
  cotal_prepared:
  SetOutPath $INSTDIR
!macroend

; Tauri's own functions set the bundle AppUserModelID on each shortcut.
!macro NSIS_HOOK_POSTINSTALL
  ${If} $CotalFresh = 1
    CreateDirectory "$LOCALAPPDATA\CotalSetup"
    FileOpen $0 "$LOCALAPPDATA\CotalSetup\result.json" w
    FileWrite $0 '{$\"schema$\":1,$\"outcome$\":$\"updated$\",$\"code$\":0,$\"message$\":$\"Cotal is installed. No background service was installed.$\",$\"activeAgents$\":0,$\"fromVersion$\":null,$\"toVersion$\":$\"${VERSION}$\"}'
    FileClose $0
  ${Else}
    nsExec::ExecToLog /TIMEOUT=360000 '"$PLUGINSDIR\setup-node.exe" "$PLUGINSDIR\service-update.mjs" finish "$INSTDIR" "${VERSION}"'
    Pop $CotalCode
    Call CotalHelperExit
    ${If} $CotalCode == "23"
      Call CotalSetupMessage
      DetailPrint "$CotalMessage"
      ${IfNot} ${Silent}
        MessageBox MB_ICONINFORMATION|MB_OK "$CotalMessage"
      ${EndIf}
      SetErrorLevel 23
    ${ElseIf} $CotalCode != "0"
      Call CotalSetupRefused
    ${EndIf}
  ${EndIf}
  StrCpy $CotalPrepared 0
  ${If} $UpdateMode <> 1
  ${AndIf} $NoShortcutMode <> 1
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}
!macroend

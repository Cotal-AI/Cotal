!define MUI_CUSTOMFUNCTION_ABORT CotalSetupAbort
!define COTAL_HOOK_DIR "${__FILEDIR__}"

Var CotalPrepared
Var CotalCopying
Var CotalCode
Var CotalMessage
Var CotalVersion
Var CotalSetupMutex
Var CotalFresh
Var CotalPhase
Var CotalUpdateMode

Function CotalSetupMessage
  ClearErrors
  FileOpen $0 "$LOCALAPPDATA\CotalSetup\message.txt" r
  IfErrors 0 +3
    StrCpy $CotalMessage "Setup could not verify background service safety. No update was authorized. Run cotal daemon start and retry setup."
    Return
  FileRead $0 $CotalMessage
  FileClose $0
FunctionEnd

Function CotalClearPhaseResult
  Delete "$LOCALAPPDATA\CotalSetup\result.json"
  Delete "$LOCALAPPDATA\CotalSetup\message.txt"
FunctionEnd

Function CotalHelperExit
  ${If} $CotalCode != "0"
  ${AndIf} $CotalCode != "20"
  ${AndIf} $CotalCode != "21"
  ${AndIf} $CotalCode != "22"
  ${AndIf} $CotalCode != "23"
    CreateDirectory "$LOCALAPPDATA\CotalSetup"
    FileOpen $0 "$LOCALAPPDATA\CotalSetup\result.json" w
    FileWrite $0 '{$\"schema$\":1,$\"outcome$\":$\"refused$\",$\"code$\":21,$\"message$\":$\"Setup helper did not complete. No success was confirmed. Run the installer again.$\",$\"activeAgents$\":0,$\"fromVersion$\":null,$\"toVersion$\":$\"$CotalVersion$\",$\"helperExit$\":$\"$CotalCode$\",$\"phase$\":$\"$CotalPhase$\"}'
    FileClose $0
    FileOpen $0 "$LOCALAPPDATA\CotalSetup\message.txt" w
    FileWrite $0 "Setup helper did not complete. No success was confirmed. Run the installer again.$\r$\n"
    FileClose $0
    StrCpy $CotalCode "21"
  ${EndIf}
FunctionEnd

; In update mode with /R, every refusal relaunches $INSTDIR\cotal-desktop.exe:
; the old app before the copy, or the new app after a finish refusal.
Function CotalSetupRefused
  Call CotalSetupMessage
  DetailPrint "$CotalMessage"
  SetErrorLevel $CotalCode
  ${If} $CotalUpdateMode = 1
    ${GetOptions} $CMDLINE "/R" $0
    ${IfNot} ${Errors}
    ${AndIf} ${FileExists} "$INSTDIR\cotal-desktop.exe"
      ${GetOptions} $CMDLINE "/ARGS" $0
      nsis_tauri_utils::RunAsUser "$INSTDIR\cotal-desktop.exe" "$0"
    ${EndIf}
  ${ElseIfNot} ${Silent}
    MessageBox MB_ICONSTOP|MB_OK "$CotalMessage"
  ${EndIf}
  Quit
FunctionEnd

Function CotalSetupAbort
  ${If} $CotalPrepared = 1
  ${AndIf} $CotalCopying <> 1
    Call CotalClearPhaseResult
    StrCpy $CotalPhase "abort"
    nsExec::ExecToLog /TIMEOUT=360000 '"$PLUGINSDIR\node.exe" "$PLUGINSDIR\service-update.mjs" abort "$INSTDIR" "$CotalVersion"'
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
  StrCpy $CotalUpdateMode $UpdateMode
  StrCpy $CotalVersion "${VERSION}"
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\CotalDesktopSetup") p .r0 ?e'
  StrCpy $CotalSetupMutex $0
  Pop $1
  ${If} $CotalSetupMutex = 0
  ${OrIf} $1 = 183
    CreateDirectory "$LOCALAPPDATA\CotalSetup"
    FileOpen $0 "$LOCALAPPDATA\CotalSetup\result.json" w
    FileWrite $0 '{$\"schema$\":1,$\"outcome$\":$\"refused$\",$\"code$\":21,$\"message$\":$\"Another Cotal setup is running. Wait for it to finish, then retry.$\",$\"activeAgents$\":0,$\"fromVersion$\":null,$\"toVersion$\":$\"$CotalVersion$\",$\"phase$\":$\"mutex$\"}'
    FileClose $0
    FileOpen $0 "$LOCALAPPDATA\CotalSetup\message.txt" w
    FileWrite $0 "Another Cotal setup is running. Wait for it to finish, then retry.$\r$\n"
    FileClose $0
    StrCpy $CotalCode "21"
    Call CotalSetupRefused
  ${EndIf}
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
    File /oname=node.exe "${COTAL_HOOK_DIR}\..\binaries\node-x86_64-pc-windows-msvc.exe"
  !else
    !error "Review the installer service helper for this Windows architecture."
  !endif
  System::Call 'kernel32::SetEnvironmentVariable(t "PSModulePath", p 0)'
  System::Call 'kernel32::SetEnvironmentVariable(t "COTAL_SETUP_ROOT", t "$INSTDIR")'
  System::Call 'kernel32::SetEnvironmentVariable(t "COTAL_SETUP_VERSION", t "${VERSION}")'
  Call CotalClearPhaseResult
  StrCpy $CotalPhase "recover"
  nsExec::ExecToStack /TIMEOUT=120000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\service-task.ps1" -Action recover'
  Pop $CotalCode
  Pop $CotalMessage
  Call CotalHelperExit
  ${If} $CotalCode != "0"
    StrCpy $CotalCode "21"
    Call CotalSetupRefused
  ${EndIf}
  ${If} $CotalMessage == "recover$\r$\n"
  ${OrIf} $CotalMessage == "recover$\n"
    StrCpy $CotalPrepared 1
  ${Else}
    cotal_prepare_retry:
    Call CotalClearPhaseResult
    StrCpy $CotalPhase "prepare"
    nsExec::ExecToLog /TIMEOUT=360000 '"$PLUGINSDIR\node.exe" "$PLUGINSDIR\service-update.mjs" prepare "$INSTDIR" "${VERSION}"'
    Pop $CotalCode
    Call CotalHelperExit
    ${If} $CotalCode == "20"
    ${AndIfNot} ${Silent}
    ${AndIf} $CotalUpdateMode <> 1
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

; The desktop shortcut is the template's: silent and passive installs create it, and the finish
; page's Create desktop shortcut box decides for everyone else.
!macro NSIS_HOOK_POSTINSTALL
  ${If} $CotalFresh = 1
    CreateDirectory "$LOCALAPPDATA\CotalSetup"
    FileOpen $0 "$LOCALAPPDATA\CotalSetup\result.json" w
    FileWrite $0 '{$\"schema$\":1,$\"outcome$\":$\"updated$\",$\"code$\":0,$\"message$\":$\"Cotal is installed. No background service was installed.$\",$\"activeAgents$\":0,$\"fromVersion$\":null,$\"toVersion$\":$\"${VERSION}$\"}'
    FileClose $0
  ${Else}
    Call CotalClearPhaseResult
    StrCpy $CotalPhase "finish"
    nsExec::ExecToLog /TIMEOUT=360000 '"$PLUGINSDIR\node.exe" "$PLUGINSDIR\service-update.mjs" finish "$INSTDIR" "${VERSION}"'
    Pop $CotalCode
    Call CotalHelperExit
    ${If} $CotalCode == "23"
      Call CotalSetupMessage
      DetailPrint "$CotalMessage"
      ${IfNot} ${Silent}
      ${AndIf} $CotalUpdateMode <> 1
        MessageBox MB_ICONINFORMATION|MB_OK "$CotalMessage"
      ${EndIf}
      SetErrorLevel 23
    ${ElseIf} $CotalCode != "0"
      Call CotalSetupRefused
    ${EndIf}
  ${EndIf}
  StrCpy $CotalPrepared 0
  ; The cotal command: this installation's bin folder goes last on the user's PATH, so a cotal that
  ; npm or the shell installer already put on PATH keeps running. An update finds it already there.
  nsExec::ExecToStack /TIMEOUT=60000 '"$INSTDIR\cotal-desktop.exe" --add-command-line'
  Pop $0
  Pop $1
  ${If} $0 != "0"
    DetailPrint "$1"
    ${IfNot} ${Silent}
    ${AndIf} $CotalUpdateMode <> 1
      MessageBox MB_ICONEXCLAMATION|MB_OK "Cotal is installed, but its cotal command could not be added to your PATH.$\r$\n$\r$\n$1"
    ${EndIf}
    SetErrorLevel 1
  ${EndIf}
!macroend

; Uninstalling removes the background service this installation registered, through the packaged
; runtime's own uninstall, before the program files go. An update (/UPDATE) keeps the service.
; A refusal stops the uninstall, so no task is left running a deleted program.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
  ${AndIf} ${FileExists} "$INSTDIR\cotal-desktop.exe"
    nsExec::ExecToStack /TIMEOUT=300000 '"$INSTDIR\cotal-desktop.exe" --remove-service'
    Pop $0
    Pop $1
    ${If} $0 != "0"
      DetailPrint "$1"
      ${IfNot} ${Silent}
        MessageBox MB_ICONSTOP|MB_OK "Cotal could not remove its background service, so nothing was uninstalled.$\r$\n$\r$\n$1"
      ${EndIf}
      SetErrorLevel 21
      Quit
    ${EndIf}
    ; With the service gone, end what still runs from here: the app and any status reader it started.
    ; Its own running-app check would end only the app, and a reader left holding node.exe keeps it.
    nsExec::ExecToStack /TIMEOUT=120000 '"$INSTDIR\cotal-desktop.exe" --close-app'
    Pop $0
    Pop $1
    ${If} $0 != "0"
      DetailPrint "$1"
      ${IfNot} ${Silent}
        MessageBox MB_ICONSTOP|MB_OK "Cotal removed its background service but could not close its running programs, so its files were not removed.$\r$\n$\r$\n$1"
      ${EndIf}
      SetErrorLevel 21
      Quit
    ${EndIf}
    ; Take this installation's bin folder off the user's PATH, before the cotal command it holds goes.
    nsExec::ExecToStack /TIMEOUT=60000 '"$INSTDIR\cotal-desktop.exe" --remove-command-line'
    Pop $0
    Pop $1
    ${If} $0 != "0"
      DetailPrint "$1"
      ${IfNot} ${Silent}
        MessageBox MB_ICONSTOP|MB_OK "Cotal could not take its cotal command off your PATH, so its files were not removed.$\r$\n$\r$\n$1"
      ${EndIf}
      SetErrorLevel 21
      Quit
    ${EndIf}
  ${EndIf}
!macroend

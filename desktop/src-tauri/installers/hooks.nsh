; Tauri's own functions set the bundle AppUserModelID on each shortcut.
!macro NSIS_HOOK_POSTINSTALL
  ${If} $UpdateMode <> 1
  ${AndIf} $NoShortcutMode <> 1
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}
!macroend

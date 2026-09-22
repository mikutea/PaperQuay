!macro customInstall
  ; Chromium's Windows sandbox requires read/execute access for restricted app packages.
  ; Use the well-known SID so the rule works on every Windows display language.
  ExecWait '"$SYSDIR\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-2:(OI)(CI)(RX)"' $0
  ${If} $0 != 0
    DetailPrint "Failed to grant restricted app package read/execute access (icacls exit $0)."
    Abort
  ${EndIf}
  ; The portable ZIP has no marker, so its built-in NSIS updater remains disabled.
  FileOpen $1 "$INSTDIR\.paperquay-nsis-install" w
  FileWrite $1 "PaperQuay NSIS installation"
  FileClose $1
!macroend

!macro customUnInstall
  Delete "$INSTDIR\.paperquay-nsis-install"
!macroend

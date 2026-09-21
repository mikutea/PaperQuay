!macro customInstall
  ; Chromium's Windows sandbox requires read/execute access for restricted app packages.
  ; Use the well-known SID so the rule works on every Windows display language.
  ExecWait '"$SYSDIR\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-2:(OI)(CI)(RX)"' $0
  ${If} $0 != 0
    DetailPrint "Failed to grant restricted app package read/execute access (icacls exit $0)."
    Abort
  ${EndIf}
!macroend

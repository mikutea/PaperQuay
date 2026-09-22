PaperQuay portable build

Extract the entire ZIP to a directory you can modify. Launch with
Start-PaperQuay.cmd, not PaperQuay.exe directly. The launcher grants the
restricted Windows app-package SID inherited read/execute access before
Chromium starts. It does not disable the sandbox.

The in-app NSIS installer update action is intentionally disabled for this
portable build. Use the verified PaperQuay fork portable updater or download a
new portable ZIP from the fork release page.

---
"cotal-ai": patch
---

The desktop app's Background service log now shows the service's output on macOS and Linux. On macOS, launchd created `daemon.log` readable by others, so the app refused to show it. On Linux the output went only to the journal. The service now makes its log private (macOS), or keeps the same bounded private copy as Windows (Linux), first thing when it starts. A space row that says "Manager is not answering" now also gives the Manager's own reason. Reading the application PATH from the login shell no longer hangs on a startup file that waits for input, or waits on a job a startup file left running. It stops at 30 seconds and kills whatever the shell started. It also works for tcsh and csh, which read `~/.login`, and for PowerShell, which reads `~/.profile`. The Windows MSI installer now registers `cotal:` links. Its template wrote the literal key `Software\Classes{{protocol}}`, so links did not open the app after an MSI install.

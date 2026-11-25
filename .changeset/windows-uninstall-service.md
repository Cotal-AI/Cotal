---
"cotal-ai": patch
---

Uninstalling the Windows desktop app now also removes the background service it set up. Before, the NSIS and MSI uninstallers left the service's scheduled task registered, so at each sign-in it tried to run the deleted program. The uninstaller now removes that service through the app's own uninstall before deleting files. It leaves a service that a separate Cotal installation registered, keeps the service during an update, and stops with the reason if the service cannot be removed.

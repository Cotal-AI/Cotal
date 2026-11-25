---
"cotal-ai": patch
---

Uninstalling the Windows desktop app now also removes the background service it set up. Before, the NSIS and MSI uninstallers left the service's scheduled task registered, so at each sign-in it tried to run the deleted program. The uninstaller now removes that service through the app's own uninstall before deleting files. It leaves a service that a separate Cotal installation registered, keeps the service during an update, and stops with the reason if the service cannot be removed. Uninstalling with the app open no longer leaves Cotal running from the deleted folder: the service is stopped first, and a silent MSI uninstall now closes the open app the way the NSIS uninstaller already did.

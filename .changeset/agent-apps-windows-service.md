---
"cotal-ai": patch
---

On Windows, an application installed from the desktop app's Agent apps screen is now picked up even when another Cotal installation set up the background service, such as a command line installed with npm. The app restarts that service unchanged so it reads the new user PATH, and the service keeps its version. When the service cannot pick an application up, the app shows it as installed and says why, instead of "Couldn't install", and the reason no longer includes the service's command line. When a Windows installer stops, the row now gives the reason the installer printed, such as Codex's "Cannot replace older standalone install without confirmation", instead of only "exit code 1".

---
"cotal-ai": patch
---

The desktop app now checks background service status every 60 seconds while its window is hidden instead of every second, and refreshes immediately when the window is shown. Tray icon click events also request an immediate refresh where the platform delivers them, while on Linux the system panel renders the tray menu from `dbusmenu` without emitting tray icon click events, so the hidden tray menu can reflect state up to 60 seconds old until the window is opened.

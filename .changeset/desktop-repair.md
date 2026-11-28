---
"cotal-ai": minor
---

The desktop app can now fix this computer from inside the app. Every error screen offers one button that fixes the cause: the screens that used to offer only "Try again" or "Check status" now offer Repair. Repair checks the background service, its version, the agent apps it finds and the spaces it runs, shows what it found and what it will change, and runs only after you choose its button. When another copy of Cotal runs the background service, Repair moves it to this app after one approval that names the agents that restart, and keeps your sign-in, this computer's identity and every space's records. If this app's service does not start, the move puts the other copy's service back. A daemon message or next step that names a command or a file path is no longer shown in the window. The same check is `cotal daemon repair` on a computer without the app, and the cross-installation refusal now carries `ANOTHER_INSTALLATION` with the owning copy's kind.

---
"cotal-ai": patch
---

If the desktop app's background service stops while sign-in or setup is waiting on it, the app now says "The background service stopped" and clears that screen once the service is running again. Before, it showed a generic error that pointed to a `cotal daemon` command the app doesn't include, and it stayed on that screen until you chose Try again.

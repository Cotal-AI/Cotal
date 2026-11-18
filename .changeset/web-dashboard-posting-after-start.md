---
"@cotal-ai/web": patch
---

The web dashboard page now changes a saved dashboard's credential or posting options with `cotal service start` while the service is stopped. It used to tell you to run `cotal service add web` again, which is refused once the definition exists, so the dashboard stayed read-only.

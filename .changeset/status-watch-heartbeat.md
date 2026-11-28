"cotal-ai": patch
---

The desktop app no longer keeps showing a stale connection status when its status stream stops without a word. The background service now repeats the current status to the app every 15 seconds even when nothing has changed, and the app re-checks the status by itself when no update has arrived for 30 seconds, so a broken stream is noticed and repaired within about a minute while a healthy one costs no extra checks.

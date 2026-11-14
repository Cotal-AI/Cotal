---
"cotal-ai": patch
"@cotal-ai/workspace": patch
---

Keep the installed Windows background service running after a manual update.

The replacement updater starts only its verified enabled scheduled task after the old daemon exits, and checks target readiness under the existing deadline. Windows updater ownership uses retained process creation identity, including guarded compatibility with published records that lack a start token.

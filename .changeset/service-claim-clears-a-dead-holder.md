---
"@cotal-ai/workspace": patch
---

`cotal service start web` works again after a dashboard crashed, was killed or could not connect. Its `web.pid` named a process that had exited, and every later start refused while `service stop` and `down` found nothing to stop. A start now clears a slot whose process has exited and claims it. A slot that may still front a running process keeps refusing, and the refusal names the file.

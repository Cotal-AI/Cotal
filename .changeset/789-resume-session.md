---
"@cotal-ai/connector-jcode": patch
---

A restarted jcode seat now resumes the session it left instead of silently starting blank. The host
called `createSession` unconditionally, so `cotal stop` followed by `cotal spawn` forked a new
session and orphaned the existing transcript: the seat came back looking healthy while remembering
nothing, and the TUI, which is spawned with `--resume`, showed an attaching human the very history
the agent could not recall. The host now looks for a prior session in the seat's own home and
attaches it, choosing conservatively: the session must declare this seat's working directory, must
not be archived, and must carry a non-empty transcript. When nothing is resumable it starts fresh
and says so, and when it does resume it does not re-send the persona briefing into a transcript that
already opens with it.

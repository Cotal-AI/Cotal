---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/auth": patch
"@cotal-ai/web": patch
"@cotal-ai/delivery": patch
"@cotal-ai/seat": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-codex": patch
"@cotal-ai/connector-jcode": patch
---

Files written in place under `~/.cotal` or a project's `.cotal` are no longer written through a symlink. The manager's own delivery-aware marker, the `agent-bearer` health file, the onboarding marker, the `setup` log and personas, the web session file and detached log, the feedback store, persona files saved by `saveAgentFile`, the seat custody record, payload, exit record and log, the Claude seat home and plugin marketplace, the Codex host log, the Jcode launch record, the `ext` extensions prefix `package.json`, and the isolated broker's config rewrite and watchdog now refuse a symlink and leave it unchanged. A file rewritten in place is set to `0600` through the open file. `hardenPrivate` on a file now uses the same no-follow descriptor. A directory is still hardened to `0700` by its path, so a symlinked `~/.cotal` or `.cotal` is not refused there. The manager and native service custody no longer chmod their pid records by path, since those are created `0600`. The broker ports report refusal names the report's path, and a failed close no longer hides it.

---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/manager": patch
"@cotal-ai/auth": patch
---

Agents launched on a second computer use a numbered name when that computer cannot continue the requested name's retained transcript.

The manager and connector share the acknowledged transcript startup check. Unreadable state or retained counts refuse the launch before provisioning, and pinned names are never silently renamed. Supervisor credentials can read CHAT subject counts for this check without reading message bodies. On older hosts that deny this metadata read, the manager logs the permission gap and leaves the agent's existing startup check in charge. Delegated runtimes are unchanged.

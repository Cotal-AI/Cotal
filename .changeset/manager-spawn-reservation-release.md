---
"@cotal-ai/manager": patch
---

The manager now runs its event-plane and static `endpointCapabilities` spawn refusals before it allocates the agent's name, and reserves the name right before the step whose cleanup releases it. Each of those refusals, and the user-mode provisioning error, used to give the reserved name back by hand, so a refusal added there that forgot the release would silently cost the next spawn of that persona its name. When a hard-pinned `--name` collision and one of these refusals both apply, the spawn now reports the event-plane or capability refusal.

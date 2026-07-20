---
"@cotal-ai/web": minor
---

Substantially improve the observability dashboard: Markdown rendering in message
bodies (with expand/collapse-all), attention (dnd/focus) and per-channel
quiet/muted indicators, channel replay + delivery-class shown at a glance and in
detail, model·variant + harness badges on the roster and graph, richer graph
node cards (agent description/tags, channel durability), resizable sidebars and
nav sections, and assorted layout/legibility fixes.

Adapt the observer tap for v0.4: subscribe the messaging planes (chat, inst, svc)
individually instead of the space-wide `>`, so the dashboard no longer taps the
v0.4 endpoint request rails.

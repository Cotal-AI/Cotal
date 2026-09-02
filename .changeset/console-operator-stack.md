---
"@cotal-ai/cli": minor
---

The console can drive the mesh as well as watch it. Every operator action (kill, spawn, status, purge, channel delete, attach) rides the CLI's own per-action control path over the endpoint rails, never the observer, using only the manager commands that already exist; `a` attaches through the full `cotal attach` loop in place; on an open mesh the operator's first send starts a presence-only peer under the observer's card so agents can reply; the topology lens overlays the broker-authoritative membership feed and says live, stale, traffic-only, or unreadable; channel tabs carry unread badges, the roster tags each agent's harness, the agent detail lists runs, model, and skills, and the status bar draws a 60-second activity sparkline.

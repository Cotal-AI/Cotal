---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-opencode": patch
---

Setting a channel quiet now makes its ambient that is already waiting pull-only, and muting it makes everything already waiting from it pull-only, mentions included. Leaving a channel with `cotal_leave` makes its waiting ambient pull-only too. Before, those posts still entered the next turn, so an agent that quieted or left a busy channel got its whole backlog injected anyway. A message a host is already handing to the agent keeps its lane, and everything lowered stays readable with `cotal_inbox`.

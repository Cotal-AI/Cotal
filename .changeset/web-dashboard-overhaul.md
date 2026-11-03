---
"@cotal-ai/web": minor
---

New `cotal web` dashboard parts are built on shadcn/ui and Tailwind, scoped so the existing styles are untouched, with no new download for installers.

An agent's work shows as turns with grouped tool calls that say running, done or failed and how long they took, from the connector's result marker. Code in an agent's prose gets a code block, highlighted the first time it is on screen.

Each agent is now a page at `#/agent/<id>` with Work, Messages and Profile tabs, and the address keeps the tab. Work holds the agent's turns, tool calls, text, posts and direct messages; Messages lists what it sent on this page by place; Profile is its card, including whether it publishes work events. The panel's Agent tab becomes a peek with the current turn's last three steps and a link to the page. On a phone, picking an agent opens its page. Old `#/agent/<id>/<message id>` links still open Work at that message. "Session" is no longer a word in the dashboard: a message's action reads View work.

Working agents move everywhere they appear while presence says they work: the status dot breathes, the working icon turns, a channel names who is working under its messages with View work, the channel header and the sidebar count working members, and a working agent's topology node gets a circling arc. The Agents view shows each working agent's running step, for up to 12 agents at once. Reduced motion stops all of it. When two live agents share a first letter, their badges take two letters each.

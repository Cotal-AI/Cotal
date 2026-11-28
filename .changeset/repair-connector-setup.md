---
"cotal-ai": patch
---

When a space stops because Cotal couldn't set up the agent app connectors on this computer, Repair now fixes it: it sets the connectors up again through the background service, then starts the space, with no terminal. Before, Repair only tried to start the space again, which failed the same way. If the connector setup still fails, Repair says so in plain words, and Details no longer shows a command line.

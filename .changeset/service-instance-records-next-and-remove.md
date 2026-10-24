---
"@cotal-ai/cli": patch
---

Several instance records of one service no longer leave every bare command stuck. A `service start|stop|restart|status|logs` that names no instance while several records exist still refuses `TARGET_AMBIGUOUS`, and its Next now lists each instance with its state, plus a `cotal service remove <name> --instance <id> --space <space> --yes` command for each stopped one. The new `service remove <name> --instance <id>` forgets only that stopped instance record, after the checks `remove` makes for every record, and keeps the definition, its other instances and the logs. A controller stack's member records are refused there. `cotal down` refused by another live service instance in the space now names `cotal svc stop <name> --instance <id> --space <space> --yes` for each one, where its Next was a literal `cotal svc stop <name>` that ran into the same ambiguity.

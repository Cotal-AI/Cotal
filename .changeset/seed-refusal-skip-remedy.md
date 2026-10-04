---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

The source-checkout refusal of the operator-global seed store now names `COTAL_SKIP_CONNECTOR_SEED=1` as the way to run other commands from a checkout, and says that isolating `XDG_CONFIG_HOME` alone does not lift it. It used to name only `XDG_CONFIG_HOME`, and a sandboxed `XDG_CONFIG_HOME` is still refused, so the remedy on the line could not be followed. The refusal still does not advertise `COTAL_ALLOW_CHECKOUT_SEED`. The CLI reference, configuration and setup internals pages say the same.

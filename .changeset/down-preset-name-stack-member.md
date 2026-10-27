---
"@cotal-ai/cli": patch
---

The `down` section of the CLI reference now says what `cotal down manager` does on a controller stack. Like `cotal service stop`, a preset name reaches the stack member built on that preset, so `cotal down manager` stops `stack-manager` and `cotal down delivery` stops `stack-delivery`, and the receipt's target names the member and the name you gave as `requested`. The page used to say `cotal down manager` refuses `TARGET_NOT_FOUND` on a controller stack, which the `service` section and the command itself contradicted. A name that is no preset, such as `nats`, still refuses `TARGET_NOT_FOUND` and names the `stack-` member to use.

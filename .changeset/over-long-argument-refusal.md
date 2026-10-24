---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

An over-long service argument now names its position and the limit. A `service add --file` definition whose launch argument is over 8192 characters refuses `SCHEMA_INVALID` with "launch argument 2 (launch.args[1]) has 8193 characters, and a launch argument holds at most 8192"; it used to say only that the input did not match the schema at `launch`. A preset's array option, such as the exec-endpoint `--handler-args`, whose argument is over its declared length refuses `USAGE_INVALID` naming that argument's position and length, before the adapter's schema is checked.

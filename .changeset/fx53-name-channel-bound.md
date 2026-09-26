---
"@cotal-ai/core": patch
---

Bound the display-name and policy-channel length at the shared validators (`MAX_NAME_LENGTH` 128, `MAX_CHANNEL_LENGTH` 4096), so an over-long name or channel is refused with the bound named instead of minting a credential that exceeds the broker's `max_control_line` and silently hanging the connect (issue #375).

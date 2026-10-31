---
"@cotal-ai/core": patch
---

`CotalEndpoint.tap` now checks messaging frames the way history and live delivery already do. A chat, DM or anycast frame whose payload sender is not the sender in its subject is dropped. A frame that passes carries the channel, recipient or role named by its subject, not the one in its payload.

Before this, the console's live feed (`cotal console`, `cotal watch`) and `cotal history --follow` could show a frame under a sender, channel, recipient or role it was never published as, and the dashboard's live feed was handed the payload's recipient and role. Frames outside the messaging planes reach the tap handler unchanged.

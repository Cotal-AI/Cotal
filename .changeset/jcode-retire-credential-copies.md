---
"@cotal-ai/connector-jcode": patch
---

A stopped or retired Jcode seat no longer keeps copies of the operator's credentials in its private home. Once a launch's stop has verified that no Jcode process of that lifecycle is left, the connector removes every credential destination its mirror can hold, through the same pinned-parent unlink the mirror uses: Jcode logins, provider `.env` files, external logins and the Cursor state extract. The home stays for its resume record, and the next launch mirrors the logins afresh. If the stop could not be verified, the copies stay. Homes left by earlier versions keep their copies until they are relaunched or removed by hand.

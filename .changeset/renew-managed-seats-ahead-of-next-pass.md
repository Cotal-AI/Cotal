---
"@cotal-ai/manager": patch
---

A Manager renewal pass now re-signs a managed seat's credential when the credential will be past its renewal point by the next pass, so the seat adopts the new credential at its own renewal point. Before, a seat whose renewal point fell just after a pass warned every minute for up to six hours, and when the next pass came in the credential's last minute the seat's connection could expire before it read the new file.

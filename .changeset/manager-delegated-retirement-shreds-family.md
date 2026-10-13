---
"@cotal-ai/manager": patch
---

`retireDelegatedAgent` now removes the seat's local secret family (actor token, sentinel creds and health file, with their secret-store entries) once the host confirms `retired: true`, before it frees the name. Before this a delegated seat's retirement reported success and released the name while the family it was enrolled with stayed on the participant. A removal that fails is reported and keeps the name held until a retried retirement intent removes it.

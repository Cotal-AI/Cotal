---
"@cotal-ai/connector-core": patch
---

A message that waits in a connector's queue past its acknowledgement wait is no longer shown as a broker redelivery with an unknown prior handoff. The connector records the first copy it received and the first copy it handed to its host. A message it never handed over carries no redelivery label. One it handed over without an acknowledgement says that an earlier handoff in this session was not confirmed. A first copy that was already a redelivery, as after a restart, still labels the prior model handoff unknown.

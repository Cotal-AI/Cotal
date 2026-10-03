---
"@cotal-ai/lang": patch
"@cotal-ai/runtime": patch
---

`spawn` in a workflow program accepts `events`, the workflow form of `cotal spawn --no-events`. `events: false` starts the seat without its AG-UI event plane, so a hosted run can now start a connector that publishes none, such as Hermes. Before this the option was refused as an unknown key (L3011), and the same spawn without it was refused by the manager because an omitted `events` arms the plane. A value that is not a boolean is refused at the spawn. Like `supervise`, the option is launch policy and is not part of the step's input hash.

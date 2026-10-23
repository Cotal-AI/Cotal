---
"@cotal-ai/cli": patch
---

A `backup create` refusal or failure now shows its cause as native detail, such as a broker still
listening at the preserved cut's endpoint. Since the command line redesign it printed only a generic
sentence, while `backup restore` and `down --preserve-state` kept naming the same cause.

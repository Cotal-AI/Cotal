---
"@cotal-ai/core": patch
---

`ConnectorSetupAction.run`, `ConnectorAssist.run` and `ConnectorSetupProvider.status` are now function-typed properties, so TypeScript checks a provider's inputs strictly. As methods they were checked bivariantly: a provider whose `skills` action required a field the CLI never sends, such as `ConnectorSkillsSetupInput & { readonly token: string }`, compiled and then failed during `cotal setup`. It is now a compile error. Providers written in method shorthand keep compiling.

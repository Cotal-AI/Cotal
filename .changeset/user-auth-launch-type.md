---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/manager": patch
---

`@cotal-ai/core` exports `UserAuthLaunch`, the user-mode launch identity (owner, actor, sentinel-creds path and bearer argv). `LaunchOpts.userAuth`, `LaunchMaterial.userAuth` and the `userAuth` option of connector-core's `materialEnv` are typed with it, and the manager references it for the identity it provisions and resumes. The shape used to be written out separately at each of those places, so a field added to one copy was dropped without a compile error wherever a narrower copy sat in between. The material reader's rebuild is now checked against every field of the type, so a new field does not compile until the reader validates it. Runtime behavior is unchanged.

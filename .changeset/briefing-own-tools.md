---
"@cotal-ai/connector-core": patch
---

Tell agents to use their cotal_* tools and to run the `cotal` command line only when the user says they may. The shared briefing every harness hands its agent gains a paragraph saying the command line runs with the user's credentials, so it can see and do things the agent can't and posts under the user's name, and that the agent tells the user what's missing when no tool covers a job. The briefing's workflow paragraph now names cotal_run instead of `cotal run start`.

---
"@cotal-ai/cli": patch
---

`cotal chat --stdio` now answers every line in the order it arrived, as the docs say. A request refused at validation, such as an unknown `type`, a line that is not JSON or one too long to read, was answered at once, ahead of the requests queued before it. A request reusing the id of one still queued was refused under that id before the first request's result, so a client matching by id read the first request as refused. Each refusal now waits its turn, so the first request's result comes before the duplicate's refusal, and the refusal says the id was still in flight when the request arrived.

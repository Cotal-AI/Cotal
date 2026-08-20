---
"@cotal-ai/web": minor
"@cotal-ai/connector-core": minor
---

Cap the dashboard delete route's request body at 8 KiB.

`POST /api/channel/delete` read its body with no size limit and no look at `content-length`, so the
ceiling on a request was the process heap: a 30 MB post was read in full, answered with a 70 MB
refusal, and cost 1.39 GB of peak RSS before the route formed any opinion.

The read now refuses at the threshold with a `413` naming the limit and the size that met it, on
both the declared length and the bytes as they arrive, so a body with no declared length is capped
too. It is never truncated to fit: a shortened channel name is a name the caller did not send, which
is the aliasing shape this route's validator already exists to refuse. Bodies under the cap, extra
fields included, are untouched.

`@cotal-ai/connector-core` is listed because it ships the docs bundle, which embeds the page this
change updates and is regenerated here. Its only diff is that regenerated file.

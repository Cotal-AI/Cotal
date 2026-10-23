---
"@cotal-ai/auth": patch
---

`cotal auth retire` said only that this CLI "has no supported retirement instrument", with a Next
that named no command, while help described it as a working route. Help now says it is not available
here, and the refusal says that one minted credential cannot be revoked on its own and names the
lever that works: rotating the space identity with `cotal reset space <space>` (or `cotal clean all
--force`), which stops every credential the space issued.

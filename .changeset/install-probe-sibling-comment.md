---
"cotal-ai": patch
---

The comment on the release workflow's `install-probe` job now says that the probe packs each runtime sibling of `cotal-ai` and checks each tarball's declared entry points. It used to say the siblings were not packed. The release docs describe the probe too. Behaviour is unchanged.

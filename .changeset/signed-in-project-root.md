---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/auth": patch
---

Allow the first setup of a signed-in catalog space to bind its project root while retaining provider-owned credentials under the catalog custody root. Catalog refresh preserves the binding, existing client credential contexts keep working, and later setup refuses another project.

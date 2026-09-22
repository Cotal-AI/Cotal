---
"@cotal-ai/core": patch
---

Add the hosted environment provider contract types, validated HTTPS bearer sources, bounded nonsecret environment records, checkpoint read-out shapes, lifetime extension capabilities, and host enrollment facts. The provider facts type carries no engine (host enrollment facts are authoritative for it) and leaves volumeId optional, absent meaning the provider did not report it.

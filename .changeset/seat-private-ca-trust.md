---
"@cotal-ai/connector-core": patch
"@cotal-ai/manager": patch
---

Forward NODE_EXTRA_CA_CERTS and SSL_CERT_FILE to launched seats so they retain the manager's private-CA trust paths without weakening TLS verification or inheriting unrelated environment settings.

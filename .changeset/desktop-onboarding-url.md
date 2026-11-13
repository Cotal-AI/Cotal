---
"cotal-ai": patch
---

Desktop onboarding links work in WebViews that do not parse custom URL schemes as hierarchical URLs. Validate the route before parsing its public coordinates with a standard HTTPS URL parser, retaining strict refusals and explicit sign-in and connection consent.

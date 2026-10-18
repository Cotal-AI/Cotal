---
"@cotal-ai/workspace": minor
---

Add bounded version-1 local service-definition input parsing and case-sensitive definition-name validation to the workstation library. Parsing checks selected-space agreement, process argument/path syntax and literal loopback HTTP readiness URLs without opening references, reading host environment values or importing adapter code. Validation compiles lazily. Controller checks for file ownership/access, path existence and installed adapter options remain separate; the current manager-only service command is unchanged.

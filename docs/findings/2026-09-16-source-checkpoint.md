# Managed-row repair source checkpoint

This branch preserves the outstanding Task84 upstream repair as captured on 2026-09-15 UTC (2026-09-16 local). It is unfinished work and must not be treated as a release-ready branch.

## Contents

The checkpoint includes all 47 selected changed or new source, test, mutation and documentation paths from the repair worktree, based on `2825505b02944ef9d17e0b62793446eb91e4dff9`. It covers managed-row authority and custody, native request transport, lifecycle history and rollback, manager/CLI integration, and the unfinished standard-envelope migration.

The original VPS worktree, its index and its private runtime evidence are unchanged by this publication. Ninety-six untracked dependency links or generated JavaScript outputs were excluded. Dependencies must come from the repository's package manifests and lockfile; emitted JavaScript beside TypeScript sources is not source authority.

## Earlier narrowly accepted evidence

The retained-agent snapshot repair passed a prior independent source/fixture review. The later nonce correction passed independent review with these identifiers:

- Review: `2e82a43305ec086b209a94dd61d3c07166fdc89e12fc58997f60c1cc3f4849d2`.
- Construction checkpoint: `3ae524ef052b10732f9acd8e1f63cb2a36d73ac61f3580dd3a429d752254aea8`.
- Seven offline controls: requester 47, custody 6, native 21 scenario groups, CLI rollback 21, manager rollback 18, host refusal 11, executor guard 4.
- Five qualified guard mutations had failing controls and restored passing controls.

Those results belong to the earlier bound source. The standard-envelope edits in this branch came afterward and have no whole-slice acceptance. No earlier green result should be applied to these later bytes.

## Outstanding work

The standard-envelope implementation is incomplete. The last recorded work included responder binding, deadline handling, provider reply ownership and caller fixture adaptation; its latest edits still need complete controls and independent review. Supported host launch, caller/process-epoch adoption, pending-operation recovery, cross-process custody serialization, bounded recovery inventory, real broker/ACL/process-death tests and packaging remain open.

The intended protocol separates stable operation identity from fresh per-attempt nonce entropy. Standard envelope fields must be validated with stock contract and envelope APIs. Old prototype records are preserved as private evidence and must not be silently rewritten or served through a legacy-wire fallback.

## Publication checks

The capture was checked for concurrent source changes. The selected files passed targeted credential-pattern and conflict-marker screening, and the checkpoint commit was checked byte-for-byte against the captured source. No candidate tests, broker, listener, package release or deployment were run as part of publication.

Private credentials, databases, dependency trees, emitted build files, process transcripts and raw runtime evidence are excluded. This branch provides source backup and a reviewable diff. It grants no runtime or release acceptance.

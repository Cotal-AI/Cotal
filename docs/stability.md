# Substrate stability

> **Project** (informative) · **For:** anyone building a product on the published packages · **See also:** [Embedding Cotal](embedding.md), [Release](release.md), the spec's [versioning rules](../SPEC.md#11-versioning-and-extensibility)

If you build on the `@cotal-ai/*` packages, this page is what you can rely on and what will change.
Two versions matter and they move independently: the **wire** version (`protocolVersion`) and the
**package** versions (npm semver).

## What is stable today

- **Wire shape: v0.3, version marker unset.** The implemented and documented binding shape is v0.3:
  both binding revisions are merged, owner+actor identity (which *supersedes* the old single-id
  grammar and re-keys every subject) and manager-free channel live delivery (which *replaced* the
  mediated live-tail; the implementation staged it as an additive overlay, but the resulting wire
  revision is breaking). The `protocolVersion` field is **optional and the reference implementation
  does not populate it**: normative [SPEC section 11](../SPEC.md#11-versioning-and-extensibility)
  still names the contract version v0.2, and cards carry no marker (a receiver treats an omitted
  marker as the v0.x line). So the shape you build against is v0.3 while nothing on the wire announces
  it, and old and new channel clients do not interoperate (core CHANGELOG). The wire is pre-1.0 and
  may still change.
- **Packages: pre-1.0 (the 0.x line).** core, workspace, auth, delivery, manager, web, and the
  connectors publish in lockstep; the current line is 0.13.x. The exact version is whatever the
  packages' `package.json` (and `cotal_docs`) report, so any number on this page is illustrative.
  These are the surfaces [Embedding Cotal](embedding.md) documents.

Buildable on today: the owner+actor identity grammar, the lateral chat/DM/task envelopes and
subjects, presence and discovery, channels, the three delivery modes, and the Plane-3 durable
backstop. The auth callout and delivery daemon are the two hardest server-side pieces and both are
standalone and merged.

## The npm semver caveat

The packages are **pre-1.0**. Under semver, a pre-1.0 line makes no compatibility promise across
minor bumps: a `0.13.x` to `0.14.0` change may break an API. So a product that embeds these packages
must **pin exact versions** and upgrade deliberately, reading the changelog and the diff, not float a
caret range. The support and deprecation policy for the embedding surface is
[below](#support-and-versioning-policy).

## The wire compatibility signal

Per [SPEC section 11](../SPEC.md#11-versioning-and-extensibility):

- `AgentCard.protocolVersion` is the one-way compatibility signal, but it is optional and the
  reference implementation currently leaves it unset (an omitted marker means "assume the v0.x
  line"). v0 has **no** in-band capability negotiation; deployments agree on the binding and version
  out of band.
- Additive changes (a new optional field, a namespaced `Part.kind`, a new subject) are
  backward-compatible and ship as a minor bump; receivers ignore what they do not recognize.
- Changing the meaning of an existing field or subject, or removing or renaming one, is breaking and
  ships under a new version marker.

Because the field is optional and the reference implementation leaves it unset, a broker cannot gate
on it today: there is no marker to read, and a v0.2-shaped and a v0.3-shaped card look the same. So a
hosted broker that must refuse wrong-wire clients gates out of band on the package or build version,
or another agreed signal. Whether `protocolVersion` becomes populated and sufficient at the v0.4 hard
cut, or a dedicated gate is added, is open operator-readiness work.

## The coming v0.4 cut

The one currently planned hard cut ahead of the substrate is the control surface's **v0.4**. It is a
deliberate pre-1.0 breaking hard cut (no dual-serving, no translation shims); old subjects,
envelopes, handlers, and credential grants are removed after the cut, and `protocolVersion` targets
`0.4` at completion.

**This is a projected break-family list, not a final inventory.** The control-surface campaign is
mid-flight (its later phases are not complete), so the exact set of deleted subjects and changed
signatures is generated from the integrated diff at cutover, not knowable precisely today. The
families that are in scope to break:

- **Control grammar.** The authority-tier service taxonomy, the old control envelope, control
  subjects and handlers, and their credential grants are deleted and replaced by the typed
  endpoint/class/instance rails.
- **Lifecycle-UID API changes.** Public durable, history, ACL, member, provision, and deprovision
  APIs change to require a lifecycle UID; `dinbox`/`dlv` subjects, ACL/member keys, and
  presence/membership schemas become lifecycle-scoped.
- **Daemon control absorbed.** The manager control plane (attach moves from a loopback endpoint to
  sessions; spawn becomes an action) and the delivery control shapes are migrated onto the surface;
  the old delivery-specific control protocol is deleted.
- **Broker floor.** v0.4 raises the minimum NATS server to 2.12.

What **stays** across v0.4: the lateral chat/DM message envelopes and the owner+actor identity
grammar. What breaks alongside the control grammar is the presence/membership and durable-delivery
**backing** grammar and API, so "only the control surface breaks" understates it.

## Building around the cut

- **Pin an exact patch** (for example `0.13.1`, not a `0.13.x` range) and treat the embedding surface as pre-1.0.
- **Shim every control-plane, lifecycle, durable-delivery, and presence/membership call** behind an
  internal client, so the v0.4 swap is one contained change rather than a rewrite. This is broader
  than "control subjects."
- **Do not ship a public API on v0.3 shapes that v0.4 deletes** until the control surface reaches its
  consolidation phase and the final v0.4 inventory exists.

## Support and versioning policy

The substrate packages stay **pre-1.0 (0.x)** for now. The project does **not** declare a 1.0 line
for them yet, because a known breaking change is still ahead (the [v0.4 cut](#the-coming-v04-cut)),
and a 1.0 promise made right before a deliberate break would be hollow. A 1.0 line is revisited once
v0.4 has landed and the hosted-composition gaps [Embedding Cotal](embedding.md) documents (the secret
seam, multi-space) have closed.

What a product embedding the packages can rely on in the meantime:

- **Pin an exact patch.** A caret or tilde range can pull in a breaking minor. Pin `0.N.P`, not
  `^0.N.P` or `~0.N`.
- **Patch is bug-fix only.** A `0.N.x` patch bump carries no intended breaking change. A **minor**
  bump (`0.N` to `0.N+1`) may break an API; read the changeset and the diff before taking one.
- **Every break is written down.** A breaking change ships with a changeset entry and a changelog
  note that names what changed, so an upgrade is never a silent surprise.
- **One minor of deprecation notice, where practical.** A symbol slated for removal is marked
  deprecated for one minor line before it is removed (soft-deprecate in `0.N`, remove in `0.N+1`).
  The v0.4 hard cut is the explicit exception: it is a coordinated break with no dual-serving,
  signalled in advance rather than soft-deprecated.
- **Supported line.** The latest minor is supported; the previous minor gets patch-level fixes until
  the next minor ships (a one-minor overlap). This is deliberately light-touch while the only
  consumer is the project's own hosted repo; it tightens (a longer window, a firmer deprecation
  period) when there are external embedders.

Until the 1.0 line exists, the [build-around guidance](#building-around-the-cut) above (pin exact,
shim the breaking families) is the safe posture.

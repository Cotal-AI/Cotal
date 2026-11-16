# Contract conformance

The public compiler validates the original twenty JSON Schema 2020-12 witnesses and the retained
thirty-three paired controls. Instance validation uses json-schema-library 11.6.16. Ajv validates
schema documents and custom meta-schemas only. The schema and instance corpus bytes are unchanged.

Build core, then run:

```sh
pnpm --filter @cotal-ai/core build
pnpm --filter @cotal-ai/core smoke:schema-conformance-20
pnpm --filter @cotal-ai/core smoke:schema-own-properties-controls
pnpm --filter @cotal-ai/core smoke:schema-conformance
node packages/core/smoke/browser-validators-build.public.mjs
```

The public runner retains the private brand, frozen pairs, original digests, own-member controls,
closed references, cache/table identity and profile bounds. The paired-control suite checks the
minimal contains witness, authored-ID retrieval-alias pointers and anchors, escaped error paths,
original rejected keys and missing-reference refusal. The browser check bundles generated modules
for a browser target and executes their verdicts with string code generation disabled. It does not
replace a real-browser or installed-package acceptance run.

Qualification rejected schemasafe 1.3.0 because it rejects existing custom meta-schema contracts
and accepts malformed unused definitions. Unadapted json-schema-library registration also fails
the retained pointer witness. The adapter registers retrieval aliases on compiled resources while
preserving authored IDs and schema bytes. No engine fallback or schema rewrite is used.

The ordinary error control now checks the documented backend-neutral API. Ajv-specific metadata
and error-array byte identity are intentionally incompatible. No mutation tests were run.

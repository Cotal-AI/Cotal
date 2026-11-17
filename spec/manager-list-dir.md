# Manager directory listing

`list-dir` is specified in [SPEC](../SPEC.md) and its schemas are generated from
`implementations/manager/src/manager-service-contract.ts` into the served, digest-verified
Manager contract. [Command reference](../docs/mesh-commands.mdx#manager-list-dir) includes both
closed JSON schemas. The general `cotal.schema.json` message schema does not enumerate endpoint
commands and is unchanged by this command. Run `pnpm gen:schema` to verify that artifact.

TypeDoc generates this reference from the source of each published `@cotal-ai/*` package
when the documentation site is built. Each import path is a module. A package's main import
path is its `index` module, so `@cotal-ai/core` is documented as `index` and
`@cotal-ai/core/session-browser` as `session-browser`.

A signature can name a type that no import path exports. That type appears by name, without
a link, and the docs build reports it as a TypeDoc warning.

The guides explain how the packages fit together:

- [Embedding Cotal](/docs/embedding/#what-you-embed) covers what a service embeds and the authority each part needs.
- [Embedding package exports](/docs/embedding-exports/) describes entry points, endpoint credentials and Manager execution contracts.
- [Examples](/docs/examples/) are working programs built on these packages.

To implement a client in another language, start with [Build a Cotal client](/docs/build-a-client/).

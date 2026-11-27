/** The `make-dir`, `clone` and `worktree` contract schemas (SPEC §9). Each names a parent directory
 *  on the Manager's host, which it resolves as `resolve-cwd` does, and answers the canonical folder a
 *  spawn then takes as its cwd. */
export const MAKE_DIR_INPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["parent", "name"],
  properties: { parent: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1, maxLength: 255 } },
} as const;
export const MAKE_DIR_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["path"],
  properties: { path: { type: "string" } },
} as const;

export const CLONE_INPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["url", "parent"],
  properties: {
    url: { type: "string", minLength: 1, maxLength: 2048 },
    parent: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1, maxLength: 255 },
    ref: { type: "string", minLength: 1, maxLength: 255 },
  },
} as const;
export const CLONE_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["path", "head", "ref", "existing"],
  properties: {
    path: { type: "string" }, head: { type: ["string", "null"] }, ref: { type: ["string", "null"] }, existing: { type: "boolean" },
  },
} as const;

export const WORKTREE_INPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["repo", "parent", "name"],
  properties: {
    repo: { type: "string", minLength: 1 },
    parent: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1, maxLength: 255 },
    branch: { type: "string", minLength: 1, maxLength: 255 },
    base: { type: "string", minLength: 1, maxLength: 255 },
  },
} as const;
export const WORKTREE_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["path", "branch", "base", "head"],
  properties: { path: { type: "string" }, branch: { type: "string" }, base: { type: "string" }, head: { type: "string" } },
} as const;

/** The node-free, synchronous contract validator shared by runtime and generated browser modules. */
import { compileSchema, draft2020, isJsonError, type JsonSchema, type SchemaNode } from "json-schema-library";

/** One failed assertion. Paths are escaped JSON Pointers, with an empty string naming the root. */
export interface ContractValidationError {
  code: string;
  instancePath: string;
  message: string;
  additionalProperty?: string;
}

/** A synchronous validator. Errors describe the last call and are null after a successful call. */
export interface ContractValidator {
  (value: unknown): boolean;
  errors: ContractValidationError[] | null;
  readonly schema: unknown;
}

const OPTIONS = { drafts: [draft2020], formatAssertion: false, throwOnInvalidSchema: true, throwOnInvalidRef: true };

/** Prepare an already profile-checked closure without any ambient resolver or code generation.
 * The registry is private to this call. Registration may mutate schema IDs, so it receives copies. */
export function prepareContractValidator(bundle: { root: unknown; members?: Record<string, unknown> }): ContractValidator {
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const registry = compileSchema({}, OPTIONS);
  const resources: SchemaNode[] = [];
  for (const [digest, member] of Object.entries(bundle.members ?? {})) {
    const uri = `cotal:${digest}`;
    registry.addRemoteSchema(uri, copy(member) as JsonSchema);
    const resource = registry.context.remotes[uri];
    // The engine indexes pointers by authored ID. The retrieval URI is a second name for the
    // same resource, not a replacement $id. Preserve both and never rewrite a reference.
    const id = resource.$id;
    if (id === undefined) throw new Error("registered resource has no identity");
    for (const table of [resource.context.refs, resource.context.anchors, resource.context.dynamicAnchors]) {
      for (const [ref, node] of Object.entries(table)) {
        if (ref === id || ref.startsWith(`${id}#`))
          table[uri + ref.slice(id.length)] = node;
      }
    }
    resources.push(resource);
  }
  if (registry.schemaErrors?.length) throw new Error("schema is invalid");
  const root = compileSchema(copy(bundle.root) as JsonSchema, { ...OPTIONS, remote: registry });
  resources.push(root);
  // Missing references must refuse registration, including those below an unused definition.
  for (const resource of resources) {
    for (const node of resource.toSchemaNodes()) {
      if (node.schema && typeof node.schema === "object" && (node.schema.$ref || node.schema.$dynamicRef)) {
        const resolved = node.resolveRef({ path: [] });
        if (isJsonError(resolved)) throw new Error(resolved.message);
      }
    }
  }
  const validate: ContractValidator = Object.assign((value: unknown): boolean => {
    const result = root.validate(value);
    if (result.errorsAsync.length) throw new Error("contract validation must be synchronous");
    validate.errors = result.valid ? null : result.errors.map((error) => {
      const property = error.code === "no-additional-properties-error" && typeof error.data.property === "string"
        ? error.data.property : undefined;
      // The key is the schema's own word, so naming it reveals nothing about the instance.
      const missing = error.code === "required-property-error" && typeof error.data.key === "string"
        ? error.data.key : undefined;
      return {
        code: String(error.code),
        instancePath: typeof error.data.pointer === "string" ? error.data.pointer.slice(1) : "",
        message: property !== undefined ? "must NOT have additional properties"
          : missing !== undefined ? `must have required property '${missing}'`
          : `schema assertion failed (${error.code})`,
        ...(property === undefined ? {} : { additionalProperty: property }),
      };
    });
    return result.valid;
  }, { errors: null as ContractValidationError[] | null, schema: copy(bundle.root) });
  return validate;
}

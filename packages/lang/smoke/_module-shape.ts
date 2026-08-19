/**
 * The shape of an EMITTED module, as the two suites that ask about it both need to ask.
 *
 * Shared rather than copied because the property it measures became load-bearing in a way it was
 * not when it was written: the engine host measured that inside the shipped SES compartment a free
 * READ evaluates to `undefined` and throws nothing (the scope proxy answers `has` for every name),
 * while a free WRITE still refuses. So the host's loud free-identifier clause is a backstop for the
 * write only, and the thing holding the read closed is this: that the emitted module has no free
 * identifier at all. A second copy of this walk could drift and still report an empty set, which is
 * exactly the answer a broken walk gives.
 */
import { parse } from "acorn";

export type Node = Record<string, unknown> & { type: string };

export const parseModule = (js: string): Node => parse(`(${js})`, { ecmaVersion: 2023, sourceType: "module" }) as unknown as Node;

// ---- a scope resolver over the EMITTED code ------------------------------------------------------

/**
 * Every identifier the emitted module references and does not bind.
 *
 * Written here rather than imported, because what it reads is not cotal-lang: it is the JavaScript
 * the emitter produces, and the property under test is exactly that this set is empty. A positive
 * control below injects a free name and requires it to be found, so an empty answer means "none",
 * never "the walk missed them".
 */
export function unbound(root: Node): string[] {
  const found = new Set<string>();
  const declare = (scope: Set<string>, pattern: Node | null): void => {
    if (pattern === null || pattern === undefined) return;
    switch (pattern.type) {
      case "Identifier":
        scope.add(pattern.name as string);
        return;
      case "AssignmentPattern":
        declare(scope, pattern.left as Node);
        return;
      case "RestElement":
        declare(scope, pattern.argument as Node);
        return;
      case "ObjectPattern":
        for (const p of pattern.properties as Node[]) declare(scope, (p.type === "RestElement" ? p.argument : p.value) as Node);
        return;
      case "ArrayPattern":
        for (const el of pattern.elements as (Node | null)[]) declare(scope, el);
        return;
      default:
        return;
    }
  };

  const walk = (node: unknown, scopes: Set<string>[]): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n, scopes);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const n = node as Node;
    const resolved = (name: string): boolean => scopes.some((s) => s.has(name));

    switch (n.type) {
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        if (n.type === "FunctionDeclaration" && n.id !== null && n.id !== undefined) declare(scopes[scopes.length - 1] as Set<string>, n.id as Node);
        const inner = new Set<string>();
        if (n.type === "FunctionExpression" && n.id !== null && n.id !== undefined) declare(inner, n.id as Node);
        for (const p of (n.params as Node[]) ?? []) declare(inner, p);
        const next = [...scopes, inner];
        for (const p of (n.params as Node[]) ?? []) walk(p, next);
        walk(n.body, next);
        return;
      }
      case "Program":
      case "BlockStatement":
      case "StaticBlock": {
        const inner = new Set<string>();
        const body = (n.body as Node[]) ?? [];
        for (const s of body) {
          if (s.type === "FunctionDeclaration" && s.id !== null && s.id !== undefined) declare(inner, s.id as Node);
          if (s.type === "VariableDeclaration") for (const d of s.declarations as Node[]) declare(inner, d.id as Node);
        }
        const next = [...scopes, inner];
        for (const s of body) walk(s, next);
        return;
      }
      case "ForStatement":
      case "ForOfStatement":
      case "ForInStatement": {
        const inner = new Set<string>();
        for (const key of ["init", "left"]) {
          const d = n[key] as Node | undefined;
          if (d?.type === "VariableDeclaration") for (const decl of d.declarations as Node[]) declare(inner, decl.id as Node);
        }
        const next = [...scopes, inner];
        for (const key of ["init", "left", "test", "update", "right", "body"]) if (n[key] !== undefined && n[key] !== null) walk(n[key], next);
        return;
      }
      case "CatchClause": {
        const inner = new Set<string>();
        declare(inner, (n.param ?? null) as Node | null);
        walk(n.body, [...scopes, inner]);
        return;
      }
      case "SwitchStatement": {
        walk(n.discriminant, scopes);
        const inner = new Set<string>();
        for (const c of (n.cases as Node[]) ?? []) {
          for (const s of (c.consequent as Node[]) ?? []) {
            if (s.type === "FunctionDeclaration" && s.id !== null && s.id !== undefined) declare(inner, s.id as Node);
            if (s.type === "VariableDeclaration") for (const d of s.declarations as Node[]) declare(inner, d.id as Node);
          }
        }
        walk(n.cases, [...scopes, inner]);
        return;
      }
      case "VariableDeclarator":
        // The name is declared by the block pass above; only the initializer is a reference site.
        walk(n.init, scopes);
        return;
      case "MemberExpression":
        walk(n.object, scopes);
        if (n.computed === true) walk(n.property, scopes);
        return;
      case "Property":
        if (n.computed === true) walk(n.key, scopes);
        walk(n.value, scopes);
        return;
      case "LabeledStatement":
        walk(n.body, scopes);
        return;
      case "BreakStatement":
      case "ContinueStatement":
        return;
      case "Identifier":
        if (!resolved(n.name as string)) found.add(n.name as string);
        return;
      default: {
        for (const [k, v] of Object.entries(n)) {
          if (k === "type" || k === "start" || k === "end" || k === "loc" || k === "range") continue;
          walk(v, scopes);
        }
        return;
      }
    }
  };

  walk(root, []);
  return [...found].sort();
}


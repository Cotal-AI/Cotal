import ts from "typescript";

/** Require the standalone version constant used by the built MCP server. */
export function checkMcpDocsStamp(source, version) {
  const tree = ts.createSourceFile("mcp.cjs", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const stamps = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "DOCS_VERSION")
      stamps.push(node.initializer && ts.isStringLiteral(node.initializer) ? node.initializer.text : null);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (tree.parseDiagnostics.length || stamps.length !== 1 || stamps[0] !== version)
    throw new Error(`materialize-claude-plugin: dist/mcp.cjs was not built at ${version}; rebuild @cotal-ai/connector-claude-code first`);
}

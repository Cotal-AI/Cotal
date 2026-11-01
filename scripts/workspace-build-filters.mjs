/** Read the named pnpm filters used by build metadata, including dependency/dependent closures. */
export function workspaceBuildSelection(tokens, dependencies) {
  const selectors = [];
  const remaining = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--filter") selectors.push(tokens[++i] ?? "");
    else if (token.startsWith("--filter=")) selectors.push(token.slice(9));
    else remaining.push(token);
  }
  if (!selectors.length) return { packages: null, tokens: remaining };
  const selected = new Set();
  const closure = (name) => {
    const out = new Set();
    const visit = (n) => {
      if (out.has(n)) return;
      out.add(n);
      for (const dep of dependencies.get(n) ?? []) visit(dep);
    };
    visit(name);
    return out;
  };
  const dependents = (name) => {
    const out = new Set([name]);
    for (let grew = true; grew;) {
      grew = false;
      for (const [pkg, deps] of dependencies) {
        if (out.has(pkg)) continue;
        if ([...deps].some((dep) => out.has(dep))) { out.add(pkg); grew = true; }
      }
    }
    return out;
  };
  for (const raw of selectors) {
    const filter = raw.replace(/^(["'])(.*)\1$/, "$2");
    const withDependencies = filter.endsWith("...");
    const withDependents = filter.startsWith("...");
    const name = filter.replace(/^\.\.\./, "").replace(/\.\.\.$/, "");
    if (!name) continue;
    const packages = withDependencies ? closure(name) : withDependents ? dependents(name) : [name];
    for (const pkg of packages) selected.add(pkg);
  }
  return { packages: selected, tokens: remaining };
}

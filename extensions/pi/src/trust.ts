/** Pi's saved project-trust decision for `cwd`, or undefined when it has none. Pi's trust store is
 *  loaded here, from the Pi host running the caller: the cotal CLI imports this package to register
 *  the connector without Pi installed, so a top-level value import would fail that load. */
export async function savedProjectTrust(cwd: string): Promise<boolean | undefined> {
  const { getAgentDir, ProjectTrustStore } = await import("@earendil-works/pi-coding-agent");
  return new ProjectTrustStore(getAgentDir()).getEntry(cwd)?.decision;
}

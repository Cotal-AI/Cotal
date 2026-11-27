/** A reverse-DNS endpoint name: at least two lowercase labels, as the operator configured it. */
export function assertLinearEndpointName(name: string): string {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(name) || name.length > 200)
    throw new Error(`"${name}" is not a reverse-DNS endpoint name (for example com.example.linear); use a namespace you own`);
  return name;
}

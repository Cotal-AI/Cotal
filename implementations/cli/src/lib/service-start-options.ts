export function serviceStartAllowsNoOpen(name: string | undefined): boolean {
  return name === "web";
}

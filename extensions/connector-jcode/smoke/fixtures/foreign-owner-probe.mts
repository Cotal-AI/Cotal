const privateState = process.argv[2];
const home = process.argv[3];
if (!privateState) throw new Error("expected private state module path");
const { shortSocketHome } = await import(privateState);

if (!home) throw new Error("expected managed home path");
try {
  shortSocketHome(home);
  console.log("ADOPTED_FOREIGN_OWNER");
  process.exitCode = 1;
} catch (error) {
  if (/owned by uid/.test(String((error as Error).message))) {
    console.log("REFUSED_FOREIGN_OWNER");
  } else {
    throw error;
  }
}

// The PTY prebuilds require glibc. Loading them on musl can crash the manager.
if (process.platform === "linux") {
  process.report.excludeNetwork = true;
  if (!process.report.getReport().header.glibcVersionRuntime) {
    console.error("Cotal requires glibc on Linux. Alpine and other musl distributions are not supported. Use a glibc distribution or container such as Debian, Ubuntu, or Fedora.");
    process.exitCode = 1;
  }
}

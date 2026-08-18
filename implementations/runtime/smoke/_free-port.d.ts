/**
 * OS-assigned free loopback port for a smoke broker. Picking from a random range
 * intermittently lands on a port the OS refuses to bind (Windows reserves scattered
 * Hyper-V/WinNAT port blocks) or one already in use; `listen(0)` avoids both.
 */
export declare const pickFreePort: () => Promise<number>;
//# sourceMappingURL=_free-port.d.ts.map
export function windowsJourneyCheckpoint(phase: 'service-recovery-complete'): Promise<void>;
/** Non-awaited passive progress. Labels contain only letters, digits and hyphens. */
export function windowsJourneyProgress(progress: { phase: string; waitingOn?: string; status: 'start' | 'complete' }): void;

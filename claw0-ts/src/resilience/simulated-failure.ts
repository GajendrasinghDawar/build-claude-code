export class SimulatedFailure {
  static readonly TEMPLATES: Record<string, string> = {
    rate_limit: "Error code: 429 -- rate limit exceeded",
    auth: "Error code: 401 -- authentication failed, invalid API key",
    timeout: "Request timed out after 30s",
    billing: "Error code: 402 -- billing quota exceeded",
    overflow: "Error: context window token overflow, too many tokens",
    unknown: "Error: unexpected internal server error",
  };

  private pendingReason: string | null = null;

  arm(reason: string): string {
    if (!(reason in SimulatedFailure.TEMPLATES)) {
      return `Unknown reason '${reason}'. Valid: ${Object.keys(SimulatedFailure.TEMPLATES).join(", ")}`;
    }

    this.pendingReason = reason;
    return `Armed: next API call will fail with '${reason}'`;
  }

  checkAndFire(): void {
    if (!this.pendingReason) return;

    const reason = this.pendingReason;
    this.pendingReason = null;
    throw new Error(SimulatedFailure.TEMPLATES[reason]);
  }

  isArmed(): boolean {
    return this.pendingReason !== null;
  }

  getPendingReason(): string | null {
    return this.pendingReason;
  }
}

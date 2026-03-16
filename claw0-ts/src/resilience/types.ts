export enum FailoverReason {
  RateLimit = "rate_limit",
  Auth = "auth",
  Timeout = "timeout",
  Billing = "billing",
  Overflow = "overflow",
  Unknown = "unknown",
}

export interface AuthProfile {
  name: string;
  provider: string;
  apiKey: string;
  cooldownUntil: number;
  failureReason: FailoverReason | null;
  lastGoodAt: number;
}

export interface ProfileStatus {
  name: string;
  provider: string;
  status: string;
  failureReason: string | null;
  lastGood: string;
}

export interface ResilienceStats {
  totalAttempts: number;
  totalSuccesses: number;
  totalFailures: number;
  totalCompactions: number;
  totalRotations: number;
  maxIterations: number;
}

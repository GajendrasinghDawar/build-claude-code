import { FailoverReason } from "./types.js";

export function classifyFailure(error: unknown): FailoverReason {
  const msg = String(error).toLowerCase();

  if (msg.includes("rate") || msg.includes("429")) {
    return FailoverReason.RateLimit;
  }
  if (msg.includes("auth") || msg.includes("401") || msg.includes("key")) {
    return FailoverReason.Auth;
  }
  if (msg.includes("timeout") || msg.includes("timed out")) {
    return FailoverReason.Timeout;
  }
  if (msg.includes("billing") || msg.includes("quota") || msg.includes("402")) {
    return FailoverReason.Billing;
  }
  if (
    msg.includes("context") ||
    msg.includes("token") ||
    msg.includes("overflow")
  ) {
    return FailoverReason.Overflow;
  }

  return FailoverReason.Unknown;
}

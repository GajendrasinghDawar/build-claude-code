import {
  FailoverReason,
  type AuthProfile,
  type ProfileStatus,
} from "./types.js";

export class ProfileManager {
  constructor(readonly profiles: AuthProfile[]) {}

  selectProfile(): AuthProfile | null {
    const now = Date.now() / 1000;
    for (const profile of this.profiles) {
      if (now >= profile.cooldownUntil) {
        return profile;
      }
    }
    return null;
  }

  selectAllAvailable(): AuthProfile[] {
    const now = Date.now() / 1000;
    return this.profiles.filter((p) => now >= p.cooldownUntil);
  }

  markFailure(
    profile: AuthProfile,
    reason: FailoverReason,
    cooldownSeconds = 300,
  ): void {
    profile.cooldownUntil = Date.now() / 1000 + cooldownSeconds;
    profile.failureReason = reason;
  }

  markSuccess(profile: AuthProfile): void {
    profile.failureReason = null;
    profile.lastGoodAt = Date.now() / 1000;
  }

  listProfiles(): ProfileStatus[] {
    const now = Date.now() / 1000;

    return this.profiles.map((p) => {
      const remaining = Math.max(0, p.cooldownUntil - now);
      const status =
        remaining === 0 ? "available" : `cooldown (${Math.round(remaining)}s)`;
      const lastGood = p.lastGoodAt
        ? new Date(p.lastGoodAt * 1000).toISOString().slice(11, 19)
        : "never";

      return {
        name: p.name,
        provider: p.provider,
        status,
        failureReason: p.failureReason,
        lastGood,
      };
    });
  }

  clearTransientCooldowns(): void {
    for (const p of this.profiles) {
      if (
        p.failureReason === FailoverReason.RateLimit ||
        p.failureReason === FailoverReason.Timeout
      ) {
        p.cooldownUntil = 0;
      }
    }
  }
}

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../keychain.js", () => ({
  readKeychainCredentials: vi.fn(),
  readCredentialsFile: vi.fn().mockReturnValue(null),
  readOpenCodeAuth: vi.fn().mockReturnValue(null),
  refreshToken: vi.fn().mockResolvedValue(null),
  isTokenExpired: vi.fn().mockReturnValue(false),
}))
vi.mock("../oauth-client.js", () => ({
  fetchOAuthUsage: vi.fn(),
  fetchOAuthProfile: vi.fn(),
}))
vi.mock("../cookie-reader.js", () => ({
  extractSessionKey: vi.fn(),
  fetchWebUsage: vi.fn(),
}))
vi.mock("../cli-probe.js", () => ({
  detectClaude: vi.fn(),
  probeCLIUsage: vi.fn(),
  probeStatus: vi.fn(),
}))

import { readKeychainCredentials } from "../keychain.js"
import { fetchOAuthUsage, fetchOAuthProfile } from "../oauth-client.js"
import { extractSessionKey, fetchWebUsage } from "../cookie-reader.js"
import { detectClaude, probeCLIUsage, probeStatus } from "../cli-probe.js"
import { fetchUsageData, resetAuthState } from "../fetcher.js"

describe("fetchUsageData fallback chain", () => {
  beforeEach(() => {
    resetAuthState()
    vi.mocked(readKeychainCredentials).mockResolvedValue(null)
    vi.mocked(fetchOAuthUsage).mockResolvedValue({ status: "failed" })
    vi.mocked(fetchOAuthProfile).mockResolvedValue(null)
    vi.mocked(detectClaude).mockResolvedValue(false)
    vi.mocked(probeCLIUsage).mockResolvedValue(null)
    vi.mocked(probeStatus).mockResolvedValue(null)
    vi.mocked(extractSessionKey).mockResolvedValue(null)
    vi.mocked(fetchWebUsage).mockResolvedValue(null)
  })

  it("returns authMethod none when all methods fail", async () => {
    const result = await fetchUsageData()
    expect(result.authMethod).toBe("none")
    expect(result.usage).toBeNull()
  })

  it("uses CLI probe when claude is installed", async () => {
    vi.mocked(detectClaude).mockResolvedValue(true)
    vi.mocked(probeCLIUsage).mockResolvedValue({
      sessionPercent: 45,
      weeklyPercent: 62,
      opusPercent: null,
      sonnetPercent: null,
      sessionReset: "5pm (Asia/Seoul)",
      weeklyReset: "May 2 at 7pm (Asia/Seoul)",
      scopedModels: [],
      email: null,
      org: null,
    })
    vi.mocked(probeStatus).mockResolvedValue({ email: "test@example.com", org: null })

    const result = await fetchUsageData()
    expect(result.authMethod).toBe("cli")
    expect(result.usage?.limits?.[0]?.percent).toBe(45)
    expect(result.usage?.limits?.[1]?.percent).toBe(62)
    expect(result.profile?.email).toBe("test@example.com")
  })

  it("skips OAuth when hasProfileScope is false", async () => {
    vi.mocked(readKeychainCredentials).mockResolvedValue({
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: Date.now() + 3600000,
      scopes: ["user:inference"],
      subscriptionType: null,
      rateLimitTier: null,
      hasProfileScope: false,
    })
    vi.mocked(detectClaude).mockResolvedValue(false)

    await fetchUsageData()
    expect(fetchOAuthUsage).not.toHaveBeenCalled()
  })

  it("on 429 falls back to CLI usage + OAuth profile", async () => {
    const mockProfile = { email: "user@example.com", plan: "max" }
    vi.mocked(readKeychainCredentials).mockResolvedValue({
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: Date.now() + 3600000,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: null,
      rateLimitTier: null,
      hasProfileScope: true,
    })
    vi.mocked(fetchOAuthUsage).mockResolvedValue({ status: "rate_limited", retryAfterMs: 60_000 })
    vi.mocked(fetchOAuthProfile).mockResolvedValue(mockProfile)
    vi.mocked(detectClaude).mockResolvedValue(true)
    vi.mocked(probeCLIUsage).mockResolvedValue({
      sessionPercent: 10,
      weeklyPercent: 20,
      opusPercent: null,
      sonnetPercent: null,
      sessionReset: "5pm (Asia/Seoul)",
      weeklyReset: "Aug 14 at 3am (Asia/Seoul)",
      scopedModels: [{ displayName: "Fable", percent: 0, resetsAt: null }],
      email: null,
      org: null,
    })

    const result = await fetchUsageData()
    expect(result.usage?.limits).toHaveLength(3)
    expect(result.usage?.limits?.[0]).toMatchObject({ kind: "session", percent: 10 })
    expect(result.usage?.limits?.[1]).toMatchObject({ kind: "weekly_all", percent: 20 })
    expect(result.usage?.limits?.[2]).toMatchObject({ kind: "weekly_scoped", percent: 0, scope: { model: { displayName: "Fable" } } })
    expect(result.profile?.email).toBe("user@example.com")
    expect(result.authMethod).toBe("oauth")
  })

  it("returns oauth when usage API succeeds", async () => {
    const mockUsage = {
      fiveHour: { utilization: 30, resetsAt: "2026-08-11T09:00:00Z" },
      sevenDay: { utilization: 15, resetsAt: "2026-08-14T00:00:00Z" },
      sevenDaySonnet: null,
      sevenDayOpus: null,
      sevenDayDesign: null,
      sevenDayRoutines: null,
      sevenDayOAuthApps: null,
      extraUsage: null,
      limits: null,
    }
    vi.mocked(readKeychainCredentials).mockResolvedValue({
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: Date.now() + 3600000,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: null,
      rateLimitTier: null,
      hasProfileScope: true,
    })
    vi.mocked(fetchOAuthUsage).mockResolvedValue({ status: "success", data: mockUsage })
    vi.mocked(fetchOAuthProfile).mockResolvedValue({ email: "user@example.com", plan: "max" })

    const result = await fetchUsageData()
    expect(result.authMethod).toBe("oauth")
    expect(result.usage?.fiveHour?.utilization).toBe(30)
    expect(result.profile?.email).toBe("user@example.com")
  })
})

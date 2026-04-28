import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../keychain.js", () => ({
  readKeychainCredentials: vi.fn(),
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
import { fetchUsageData } from "../fetcher.js"

describe("fetchUsageData fallback chain", () => {
  beforeEach(() => {
    vi.mocked(readKeychainCredentials).mockResolvedValue(null)
    vi.mocked(fetchOAuthUsage).mockResolvedValue(null)
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
      email: null,
      org: null,
    })
    vi.mocked(probeStatus).mockResolvedValue({ email: "test@example.com", org: null })

    const result = await fetchUsageData()
    expect(result.authMethod).toBe("cli")
    expect(result.usage?.fiveHour?.utilization).toBe(45)
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
})

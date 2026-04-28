import { describe, it, expect, vi, beforeEach } from "vitest"
import { snakeToCamel, fetchOAuthUsage } from "../oauth-client.js"

describe("snakeToCamel", () => {
  it("converts snake_case keys to camelCase", () => {
    const input = { five_hour: { utilization: 45, resets_at: "2026-05-01T00:00:00Z" } }
    const result = snakeToCamel(input) as any
    expect(result.fiveHour).toBeDefined()
    expect(result.fiveHour.utilization).toBe(45)
    expect(result.fiveHour.resetsAt).toBe("2026-05-01T00:00:00Z")
  })

  it("handles nested objects", () => {
    const input = { extra_usage: { is_enabled: true, monthly_limit: 50000 } }
    const result = snakeToCamel(input) as any
    expect(result.extraUsage.isEnabled).toBe(true)
    expect(result.extraUsage.monthlyLimit).toBe(50000)
  })
})

describe("fetchOAuthUsage", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
  })

  it("returns null on 401 response", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 401 }))
    const result = await fetchOAuthUsage("invalid-token")
    expect(result).toBeNull()
  })

  it("returns null on 403 response", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 403 }))
    const result = await fetchOAuthUsage("scope-missing-token")
    expect(result).toBeNull()
  })

  it("parses valid usage response with snake_case conversion", async () => {
    const rawBody = JSON.stringify({
      five_hour: { utilization: 45, resets_at: "2026-05-01T12:00:00Z" },
      seven_day: { utilization: 62, resets_at: "2026-05-05T00:00:00Z" },
    })
    vi.mocked(fetch).mockResolvedValue(new Response(rawBody, { status: 200 }))
    const result = await fetchOAuthUsage("valid-token")
    expect(result).not.toBeNull()
    expect(result?.fiveHour?.utilization).toBe(45)
    expect(result?.sevenDay?.utilization).toBe(62)
  })
})

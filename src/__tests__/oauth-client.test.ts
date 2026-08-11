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

  it("returns failed on 401 response", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 401 }))
    const result = await fetchOAuthUsage("invalid-token")
    expect(result.status).toBe("failed")
  })

  it("returns failed on 403 response", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 403 }))
    const result = await fetchOAuthUsage("scope-missing-token")
    expect(result.status).toBe("failed")
  })

  it("returns rate_limited on 429 response with retry-after", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(
      JSON.stringify({ error: { type: "rate_limit_error" } }),
      { status: 429, headers: { "retry-after": "120" } },
    ))
    const result = await fetchOAuthUsage("valid-token")
    expect(result.status).toBe("rate_limited")
    if (result.status === "rate_limited") {
      expect(result.retryAfterMs).toBe(120_000)
    }
  })

  it("parses valid usage response with snake_case conversion", async () => {
    const rawBody = JSON.stringify({
      five_hour: { utilization: 45, resets_at: "2026-05-01T12:00:00Z" },
      seven_day: { utilization: 62, resets_at: "2026-05-05T00:00:00Z" },
    })
    vi.mocked(fetch).mockResolvedValue(new Response(rawBody, { status: 200 }))
    const result = await fetchOAuthUsage("valid-token")
    expect(result.status).toBe("success")
    if (result.status === "success") {
      expect(result.data.fiveHour?.utilization).toBe(45)
      expect(result.data.sevenDay?.utilization).toBe(62)
    }
  })
})

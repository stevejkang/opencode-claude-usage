import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs"
import { execFileSync } from "node:child_process"

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    mkdirSync: vi.fn(),
  }
})

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return {
    ...actual,
    execFileSync: vi.fn(),
    execFile: vi.fn(),
  }
})

vi.mock("../keychain.js", () => ({
  readKeychainCredentials: vi.fn().mockResolvedValue(null),
  readCredentialsFile: vi.fn().mockReturnValue(null),
  readOpenCodeAuth: vi.fn().mockReturnValue(null),
  refreshToken: vi.fn().mockResolvedValue(null),
  isTokenExpired: vi.fn().mockReturnValue(false),
}))
vi.mock("../oauth-client.js", () => ({
  fetchOAuthUsage: vi.fn().mockResolvedValue({ status: "failed" }),
  fetchOAuthProfile: vi.fn().mockResolvedValue(null),
}))
vi.mock("../cookie-reader.js", () => ({
  extractSessionKey: vi.fn().mockResolvedValue(null),
  fetchWebUsage: vi.fn().mockResolvedValue(null),
}))
vi.mock("../cli-probe.js", () => ({
  detectClaude: vi.fn().mockResolvedValue(false),
  probeCLIUsage: vi.fn().mockResolvedValue(null),
  probeStatus: vi.fn().mockResolvedValue(null),
}))

import { createRefreshLoop, resetAuthState, getCurrentEmail } from "../fetcher.js"

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

const makeFetchResult = (email: string) => ({
  usage: mockUsage,
  profile: { email, plan: "active" },
  authMethod: "oauth" as const,
})

function makeV1Cache(email: string | null) {
  return JSON.stringify({
    timestamp: Date.now(),
    email,
    result: makeFetchResult(email ?? "unknown@test.com"),
  })
}

function makeV2Cache(accounts: Record<string, { email: string }>) {
  const entries: Record<string, { timestamp: number; result: ReturnType<typeof makeFetchResult> }> = {}
  for (const [key, { email }] of Object.entries(accounts)) {
    entries[key] = { timestamp: Date.now(), result: makeFetchResult(email) }
  }
  return JSON.stringify({ version: 2, accounts: entries })
}

describe("cache schema", () => {
  beforeEach(() => {
    resetAuthState()
    vi.mocked(readFileSync).mockReset()
    vi.mocked(writeFileSync).mockReset()
    vi.mocked(renameSync).mockReset()
    vi.mocked(mkdirSync).mockReset()
    vi.mocked(execFileSync).mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("getCurrentEmail", () => {
    it("returns email from claude auth status", () => {
      vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ email: "a@test.com" }))
      expect(getCurrentEmail()).toBe("a@test.com")
    })

    it("returns null when claude auth status fails", () => {
      vi.mocked(execFileSync).mockImplementation(() => { throw new Error("not found") })
      expect(getCurrentEmail()).toBeNull()
    })
  })

  describe("V1 → V2 migration", () => {
    it("migrates V1 cache and writes V2 on first read", () => {
      vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ email: "a@test.com" }))
      vi.mocked(readFileSync).mockReturnValue(makeV1Cache("a@test.com"))

      const states: Array<{ profile: { email: string } | null }> = []
      const loop = createRefreshLoop((s) => { states.push(s as any) }, 60_000)
      loop.start()
      loop.stop()

      expect(writeFileSync).toHaveBeenCalled()
      const writtenData = vi.mocked(writeFileSync).mock.calls[0]?.[1] as string
      const parsed = JSON.parse(writtenData)
      expect(parsed.version).toBe(2)
      expect(parsed.accounts["a@test.com"]).toBeDefined()
      expect(parsed.accounts["a@test.com"].result.profile.email).toBe("a@test.com")
    })

    it("migrates V1 with null email to __unknown__ key", () => {
      vi.mocked(execFileSync).mockImplementation(() => { throw new Error() })
      vi.mocked(readFileSync).mockReturnValue(makeV1Cache(null))

      const loop = createRefreshLoop(() => {}, 60_000)
      loop.start()
      loop.stop()

      const writtenData = vi.mocked(writeFileSync).mock.calls[0]?.[1] as string
      const parsed = JSON.parse(writtenData)
      expect(parsed.version).toBe(2)
      expect(parsed.accounts["__unknown__"]).toBeDefined()
    })
  })

  describe("multi-account cache isolation", () => {
    it("returns correct cache for matching email", () => {
      vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ email: "a@test.com" }))
      vi.mocked(readFileSync).mockReturnValue(
        makeV2Cache({
          "a@test.com": { email: "a@test.com" },
          "b@test.com": { email: "b@test.com" },
        }),
      )

      const states: Array<{ profile: { email: string } | null }> = []
      const loop = createRefreshLoop((s) => { states.push(s as any) }, 60_000)
      loop.start()
      loop.stop()

      const cachedState = states.find((s) => s.profile?.email === "a@test.com")
      expect(cachedState).toBeDefined()
      expect(cachedState?.profile?.email).toBe("a@test.com")
    })

    it("does not return cache for different email", () => {
      vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ email: "c@test.com" }))
      vi.mocked(readFileSync).mockReturnValue(
        makeV2Cache({
          "a@test.com": { email: "a@test.com" },
          "b@test.com": { email: "b@test.com" },
        }),
      )

      const states: Array<{ status: string; profile: { email: string } | null }> = []
      const loop = createRefreshLoop((s) => { states.push(s as any) }, 60_000)
      loop.start()
      loop.stop()

      const cachedState = states.find((s) => s.profile?.email === "a@test.com" || s.profile?.email === "b@test.com")
      expect(cachedState).toBeUndefined()
    })
  })

  describe("account switch detection", () => {
    it("clears in-memory state when email changes between refreshes", async () => {
      let callCount = 0
      vi.mocked(execFileSync).mockImplementation(() => {
        callCount++
        return callCount <= 1
          ? JSON.stringify({ email: "a@test.com" })
          : JSON.stringify({ email: "b@test.com" })
      })
      vi.mocked(readFileSync).mockImplementation(() => { throw new Error("no cache") })

      const states: Array<{ status: string; profile: { email: string } | null }> = []
      const loop = createRefreshLoop((s) => { states.push(s as any) }, 100)
      loop.start()

      await new Promise((r) => setTimeout(r, 350))
      loop.stop()

      const loadingStates = states.filter((s) => s.status === "loading")
      expect(loadingStates.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe("expired cache", () => {
    it("ignores cache entries older than CACHE_MAX_AGE_MS", () => {
      vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ email: "a@test.com" }))

      const expiredEntry = JSON.stringify({
        version: 2,
        accounts: {
          "a@test.com": {
            timestamp: Date.now() - 11 * 60 * 1000,
            result: makeFetchResult("a@test.com"),
          },
        },
      })
      vi.mocked(readFileSync).mockReturnValue(expiredEntry)

      const states: Array<{ status: string; data: unknown }> = []
      const loop = createRefreshLoop((s) => { states.push(s as any) }, 60_000)
      loop.start()
      loop.stop()

      const successFromCache = states.find((s) => s.status === "success" && s.data !== null)
      expect(successFromCache).toBeUndefined()
    })
  })
})

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { readKeychainCredentials, readCredentialsFile, readOpenCodeAuth, refreshToken, isTokenExpired } from "./keychain"
import { fetchOAuthUsage, fetchOAuthProfile } from "./oauth-client"
import { extractSessionKey, fetchWebUsage } from "./cookie-reader"
import { detectClaude, probeCLIUsage, probeStatus } from "./cli-probe"
import type { UsageState, OAuthUsageResponse, OAuthUsageResult, LimitEntry, ProfileResponse, AuthMethod } from "./types"

interface FetchResult {
  usage: OAuthUsageResponse | null
  profile: ProfileResponse | null
  authMethod: AuthMethod
}

const CACHE_DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode-claude-usage")
const CACHE_FILE = join(CACHE_DIR, "last.json")
const CACHE_MAX_AGE_MS = 10 * 60 * 1000

interface CachedResult {
  timestamp: number
  email: string | null
  result: FetchResult
}

function readCache(email?: string | null): FetchResult | null {
  try {
    const raw = readFileSync(CACHE_FILE, "utf8")
    const cached = JSON.parse(raw) as CachedResult
    if (Date.now() - cached.timestamp > CACHE_MAX_AGE_MS) return null
    if (!cached.result?.usage) return null
    if (email && cached.email && cached.email !== email) return null
    return cached.result
  } catch {
    return null
  }
}

function writeCache(result: FetchResult): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    const cached: CachedResult = {
      timestamp: Date.now(),
      email: result.profile?.email ?? null,
      result,
    }
    const tmpFile = `${CACHE_FILE}.${process.pid}.tmp`
    writeFileSync(tmpFile, JSON.stringify(cached), { encoding: "utf8", mode: 0o600 })
    renameSync(tmpFile, CACHE_FILE)
  } catch {}
}

/**
 * Fetch Claude usage data via 6-step fallback chain:
 * 0. Environment variable token (CLAUDE_CODE_OAUTH_TOKEN)
 * 1. Credentials file (~/.claude/.credentials.json)
 * 2. OpenCode auth.json + token refresh
 * 3. Keychain (macOS only, user:profile scope required)
 * 4. CLI PTY probe (macOS/Linux, Python3 required)
 * 5. Browser cookies (Chrome/Firefox)
 *
 * Never throws. Always returns a FetchResult.
 */
const failedTokens = new Set<string>()
let lastRefreshedToken: string | null = null
let rateLimitedUntil = 0
let lastOAuthUsage: OAuthUsageResponse | null = null

export function resetAuthState(): void {
  failedTokens.clear()
  lastRefreshedToken = null
  rateLimitedUntil = 0
  lastOAuthUsage = null
}

type TryOAuthResult =
  | { ok: true; result: FetchResult }
  | { ok: false; rateLimited: boolean; profile: ProfileResponse | null }

async function tryOAuthToken(token: string): Promise<TryOAuthResult> {
  if (failedTokens.has(token)) return { ok: false, rateLimited: false, profile: null }

  if (Date.now() < rateLimitedUntil) {
    const profile = await fetchOAuthProfile(token)
    return { ok: false, rateLimited: true, profile }
  }

  try {
    const [usageResult, profile] = await Promise.all([
      fetchOAuthUsage(token),
      fetchOAuthProfile(token),
    ])

    if (usageResult.status === "success") {
      rateLimitedUntil = 0
      lastOAuthUsage = usageResult.data
      return { ok: true, result: { usage: usageResult.data, profile, authMethod: "oauth" } }
    }

    if (usageResult.status === "rate_limited") {
      rateLimitedUntil = Date.now() + usageResult.retryAfterMs
      return { ok: false, rateLimited: true, profile }
    }

    failedTokens.add(token)
    return { ok: false, rateLimited: false, profile: null }
  } catch {
    failedTokens.add(token)
    return { ok: false, rateLimited: false, profile: null }
  }
}

function mapCLIProbeToUsage(
  probeResult: NonNullable<Awaited<ReturnType<typeof probeCLIUsage>>>,
): OAuthUsageResponse {
  if (lastOAuthUsage) {
    return patchOAuthWithCLI(lastOAuthUsage, probeResult)
  }
  return buildLimitsFromCLI(probeResult)
}

function patchOAuthWithCLI(
  oauth: OAuthUsageResponse,
  cli: NonNullable<Awaited<ReturnType<typeof probeCLIUsage>>>,
): OAuthUsageResponse {
  const limits = oauth.limits ? oauth.limits.map((entry) => {
    if (entry.kind === "session" && cli.sessionPercent !== null) {
      return { ...entry, percent: cli.sessionPercent, resetsAt: cli.sessionReset ?? entry.resetsAt }
    }
    if (entry.kind === "weekly_all" && cli.weeklyPercent !== null) {
      return { ...entry, percent: cli.weeklyPercent, resetsAt: cli.weeklyReset ?? entry.resetsAt }
    }
    const modelName = entry.scope?.model?.displayName?.toLowerCase()
    if (entry.kind === "weekly_scoped" && modelName) {
      const cliModel = cli.scopedModels.find((m) => m.displayName.toLowerCase() === modelName)
      if (cliModel) {
        return { ...entry, percent: cliModel.percent, resetsAt: cliModel.resetsAt ?? entry.resetsAt }
      }
    }
    return entry
  }) : null

  return {
    ...oauth,
    fiveHour: cli.sessionPercent !== null
      ? { utilization: cli.sessionPercent, resetsAt: cli.sessionReset ?? oauth.fiveHour?.resetsAt ?? null }
      : oauth.fiveHour,
    sevenDay: cli.weeklyPercent !== null
      ? { utilization: cli.weeklyPercent, resetsAt: cli.weeklyReset ?? oauth.sevenDay?.resetsAt ?? null }
      : oauth.sevenDay,
    limits,
  }
}

function buildLimitsFromCLI(
  probeResult: NonNullable<Awaited<ReturnType<typeof probeCLIUsage>>>,
): OAuthUsageResponse {
  const limits: LimitEntry[] = []

  if (probeResult.sessionPercent !== null) {
    limits.push({
      kind: "session", group: "session", percent: probeResult.sessionPercent,
      severity: "normal", resetsAt: probeResult.sessionReset, scope: null, isActive: true,
    })
  }

  if (probeResult.weeklyPercent !== null) {
    limits.push({
      kind: "weekly_all", group: "weekly", percent: probeResult.weeklyPercent,
      severity: "normal", resetsAt: probeResult.weeklyReset, scope: null,
      isActive: probeResult.weeklyPercent > 0 || probeResult.weeklyReset !== null,
    })
  }

  for (const model of probeResult.scopedModels) {
    limits.push({
      kind: "weekly_scoped", group: "weekly", percent: model.percent,
      severity: "normal", resetsAt: model.resetsAt,
      scope: { model: { id: null, displayName: model.displayName }, surface: null },
      isActive: model.percent > 0 || model.resetsAt !== null,
    })
  }

  return {
    fiveHour: probeResult.sessionPercent !== null
      ? { utilization: probeResult.sessionPercent, resetsAt: probeResult.sessionReset }
      : null,
    sevenDay: probeResult.weeklyPercent !== null
      ? { utilization: probeResult.weeklyPercent, resetsAt: probeResult.weeklyReset }
      : null,
    sevenDaySonnet: null, sevenDayOpus: null, sevenDayDesign: null,
    sevenDayRoutines: null, sevenDayOAuthApps: null, extraUsage: null, limits,
  }
}

export async function fetchUsageData(): Promise<FetchResult> {
  failedTokens.clear()

  let oauthProfile: ProfileResponse | null = null
  let wasRateLimited = false

  // ── Step 0: Environment variable token (works on all OS)
  try {
    const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
    if (envToken) {
      const attempt = await tryOAuthToken(envToken)
      if (attempt.ok) return attempt.result
      if (attempt.rateLimited) wasRateLimited = true
      if (attempt.profile) oauthProfile = attempt.profile
    }
  } catch {}

  // ── Step 1: Credentials file (~/.claude/.credentials.json, cross-platform)
  try {
    const fileCreds = readCredentialsFile()
    if (fileCreds) {
      const attempt = await tryOAuthToken(fileCreds.accessToken)
      if (attempt.ok) return attempt.result
      if (attempt.rateLimited) wasRateLimited = true
      if (attempt.profile) oauthProfile = attempt.profile
    }
  } catch {}

  // ── Step 2: OpenCode auth.json + token refresh (cross-platform)
  try {
    const ocAuth = readOpenCodeAuth()
    if (ocAuth) {
      let token = lastRefreshedToken ?? ocAuth.accessToken
      if ((!lastRefreshedToken && isTokenExpired(ocAuth.expiresAt)) && ocAuth.refreshToken) {
        const refreshed = await refreshToken(ocAuth.refreshToken)
        if (refreshed) {
          token = refreshed.accessToken
          lastRefreshedToken = token
        }
      }
      const attempt = await tryOAuthToken(token)
      if (attempt.ok) return attempt.result
      if (attempt.rateLimited) wasRateLimited = true
      if (attempt.profile) oauthProfile = attempt.profile
    }
  } catch {}

  // ── Step 3: Keychain (macOS only, skip if no user:profile scope)
  try {
    const credentials = await readKeychainCredentials()
    if (credentials?.hasProfileScope) {
      const attempt = await tryOAuthToken(credentials.accessToken)
      if (attempt.ok) return attempt.result
      if (attempt.rateLimited) wasRateLimited = true
      if (attempt.profile) oauthProfile = attempt.profile
    }
  } catch {}

  // ── Rate-limited but have previous OAuth data → reuse it
  if (wasRateLimited && lastOAuthUsage) {
    return {
      usage: lastOAuthUsage,
      profile: oauthProfile,
      authMethod: "oauth",
    }
  }

  // ── Step 4: CLI PTY probe (macOS/Linux, primary when OAuth unavailable)
  try {
    const installed = await detectClaude()
    if (installed) {
      const probeResult = await probeCLIUsage()

      if (probeResult) {
        const usage = mapCLIProbeToUsage(probeResult)

        const profile: ProfileResponse | null = oauthProfile
          ?? await probeStatus().then(
            (s) => s ? { email: s.email, plan: s.org } : null,
          )

        return { usage, profile, authMethod: "cli" }
      }
    }
  } catch {
    // continue
  }

  // ── Step 5: Browser cookies (macOS/Linux)
  try {
    const sessionKey = await extractSessionKey()
    if (sessionKey) {
      const usage = await fetchWebUsage(sessionKey)
      if (usage) {
        return { usage, profile: oauthProfile, authMethod: "cookie" }
      }
    }
  } catch {
    // continue
  }

  return { usage: null, profile: null, authMethod: "none" }
}


/**
 * Create a refresh loop that calls fetchUsageData() on an interval.
 * Prevents duplicate concurrent fetches with a refreshing flag.
 * Preserves stale data during loading to prevent UI flicker.
 */
export function createRefreshLoop(
  setState: (state: UsageState) => void,
  intervalMs: number,
): { start: () => void; stop: () => void } {
  let timer: ReturnType<typeof setInterval> | null = null
  let refreshing = false
  let lastData: UsageState["data"] = null
  let lastProfile: UsageState["profile"] = null
  let lastAuthMethod: UsageState["authMethod"] = "none"
  let isFirstRun = true

  async function refresh(): Promise<void> {
    if (refreshing) return
    refreshing = true

    if (isFirstRun) {
      const cached = readCache()
      if (cached && cached.usage) {
        lastData = cached.usage
        lastProfile = cached.profile
        lastAuthMethod = cached.authMethod
        if (cached.authMethod === "oauth") {
          lastOAuthUsage = cached.usage
        }
        setState({
          status: "success",
          data: cached.usage,
          profile: cached.profile,
          authMethod: cached.authMethod,
          error: null,
        })
      }
    }

    if (!lastData) {
      setState({
        status: "loading",
        data: null,
        profile: null,
        authMethod: "none",
        error: null,
      })
    }

    try {
      const result = await fetchUsageData()

      if (result.authMethod === "none") {
        if (lastData) {
          setState({
            status: "success",
            data: lastData,
            profile: lastProfile,
            authMethod: lastAuthMethod,
            error: null,
          })
        } else {
          lastData = null
          lastProfile = null
          lastAuthMethod = "none"
          setState({
            status: "not-configured",
            data: null,
            profile: null,
            authMethod: "none",
            error: null,
          })
        }
      } else {
        lastData = result.usage
        lastProfile = result.profile
        lastAuthMethod = result.authMethod
        writeCache(result)
        setState({
          status: "success",
          data: result.usage,
          profile: result.profile,
          authMethod: result.authMethod,
          error: null,
        })
      }
    } catch (err) {
      setState({
        status: lastData ? "success" : "error",
        data: lastData,
        profile: lastProfile,
        authMethod: lastAuthMethod,
        error: lastData ? null : String(err),
      })
    } finally {
      refreshing = false
      isFirstRun = false
    }
  }

  return {
    start() {
      if (timer !== null) return
      void refresh()
      timer = setInterval(() => { void refresh() }, intervalMs)
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}

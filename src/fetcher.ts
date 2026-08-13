import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs"
import { execFileSync } from "node:child_process"
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

const CACHE_SCHEMA_VERSION = 2
const UNKNOWN_ACCOUNT_KEY = "__unknown__"

interface CachedEntry {
  timestamp: number
  result: FetchResult
}

interface CacheStoreV2 {
  version: typeof CACHE_SCHEMA_VERSION
  accounts: Record<string, CachedEntry>
}

interface CacheStoreV1 {
  timestamp: number
  email: string | null
  result: FetchResult
}

function isCacheV1(parsed: unknown): parsed is CacheStoreV1 {
  if (parsed === null || typeof parsed !== "object") return false
  const obj = parsed as Record<string, unknown>
  return "result" in obj && "timestamp" in obj && typeof obj.timestamp === "number"
}

function isCacheV2(parsed: unknown): parsed is CacheStoreV2 {
  if (parsed === null || typeof parsed !== "object") return false
  const obj = parsed as Record<string, unknown>
  return obj.version === CACHE_SCHEMA_VERSION && typeof obj.accounts === "object"
}

function migrateV1toV2(v1: CacheStoreV1): CacheStoreV2 {
  const key = v1.email ?? UNKNOWN_ACCOUNT_KEY
  return {
    version: CACHE_SCHEMA_VERSION,
    accounts: { [key]: { timestamp: v1.timestamp, result: v1.result } },
  }
}

function readCacheStore(): CacheStoreV2 {
  try {
    const raw = readFileSync(CACHE_FILE, "utf8")
    const parsed = JSON.parse(raw) as unknown

    if (isCacheV2(parsed)) return parsed

    if (isCacheV1(parsed)) {
      const migrated = migrateV1toV2(parsed)
      writeCacheStore(migrated)
      return migrated
    }

    return { version: CACHE_SCHEMA_VERSION, accounts: {} }
  } catch {
    return { version: CACHE_SCHEMA_VERSION, accounts: {} }
  }
}

function writeCacheStore(store: CacheStoreV2): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    const tmpFile = `${CACHE_FILE}.${process.pid}.tmp`
    writeFileSync(tmpFile, JSON.stringify(store), { encoding: "utf8", mode: 0o600 })
    renameSync(tmpFile, CACHE_FILE)
  } catch {}
}

function readCache(email: string | null): FetchResult | null {
  const store = readCacheStore()
  const key = email ?? UNKNOWN_ACCOUNT_KEY
  const entry = store.accounts[key]
  if (!entry) return null
  if (Date.now() - entry.timestamp > CACHE_MAX_AGE_MS) return null
  if (!entry.result?.usage) return null
  return entry.result
}

function writeCache(email: string | null, result: FetchResult): void {
  const store = readCacheStore()
  const key = email ?? UNKNOWN_ACCOUNT_KEY
  store.accounts[key] = { timestamp: Date.now(), result }
  writeCacheStore(store)
}

export function getCurrentEmail(): string | null {
  try {
    const stdout = execFileSync("claude", ["auth", "status"], {
      timeout: 3_000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    })
    const data = JSON.parse(stdout as string) as Record<string, unknown>
    if (typeof data.email === "string") return data.email
  } catch {}

  return null
}

/**
 * Fetch Claude usage data via 6-step fallback chain:
 * 0. Keychain (macOS only, user:profile scope required — updated immediately by claude login)
 * 1. Environment variable token (CLAUDE_CODE_OAUTH_TOKEN)
 * 2. Credentials file (~/.claude/.credentials.json)
 * 3. OpenCode auth.json + token refresh
 * 4. CLI PTY probe (macOS/Linux, Python3 required)
 * 5. Browser cookies (Chrome/Firefox)
 *
 * When expectedEmail is given, OAuth steps whose profile email differs
 * are treated as failures so the chain falls through to the next source.
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

async function tryOAuthToken(token: string, expectedEmail: string | null): Promise<TryOAuthResult> {
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

    if (expectedEmail && profile?.email && profile.email !== expectedEmail) {
      failedTokens.add(token)
      return { ok: false, rateLimited: false, profile: null }
    }

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

export async function fetchUsageData(expectedEmail: string | null = null): Promise<FetchResult> {
  failedTokens.clear()

  let oauthProfile: ProfileResponse | null = null
  let wasRateLimited = false

  // ── Step 0: Keychain (macOS — claude login updates this immediately)
  try {
    const credentials = await readKeychainCredentials()
    if (credentials?.hasProfileScope) {
      const attempt = await tryOAuthToken(credentials.accessToken, expectedEmail)
      if (attempt.ok) return attempt.result
      if (attempt.rateLimited) wasRateLimited = true
      if (attempt.profile) oauthProfile = attempt.profile
    }
  } catch {}

  // ── Step 1: Environment variable token (works on all OS)
  try {
    const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
    if (envToken) {
      const attempt = await tryOAuthToken(envToken, expectedEmail)
      if (attempt.ok) return attempt.result
      if (attempt.rateLimited) wasRateLimited = true
      if (attempt.profile) oauthProfile = attempt.profile
    }
  } catch {}

  // ── Step 2: Credentials file (~/.claude/.credentials.json, cross-platform)
  try {
    const fileCreds = readCredentialsFile()
    if (fileCreds) {
      const attempt = await tryOAuthToken(fileCreds.accessToken, expectedEmail)
      if (attempt.ok) return attempt.result
      if (attempt.rateLimited) wasRateLimited = true
      if (attempt.profile) oauthProfile = attempt.profile
    }
  } catch {}

  // ── Step 3: OpenCode auth.json + token refresh (cross-platform)
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
      const attempt = await tryOAuthToken(token, expectedEmail)
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
  let lastEmail: string | null = null
  let isFirstRun = true

  async function refresh(): Promise<void> {
    if (refreshing) return
    refreshing = true

    const currentEmail = getCurrentEmail()

    if (lastEmail !== null && currentEmail !== lastEmail) {
      resetAuthState()
      lastData = null
      lastProfile = null
      lastAuthMethod = "none"
    }
    lastEmail = currentEmail

    if (isFirstRun) {
      const cached = readCache(currentEmail)
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
      const result = await fetchUsageData(currentEmail)

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
        const cacheKey = currentEmail ?? result.profile?.email ?? null
        lastData = result.usage
        lastProfile = result.profile
        lastAuthMethod = result.authMethod
        writeCache(cacheKey, result)
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

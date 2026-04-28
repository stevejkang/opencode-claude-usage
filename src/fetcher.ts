import { readKeychainCredentials } from "./keychain.js"
import { fetchOAuthUsage, fetchOAuthProfile } from "./oauth-client.js"
import { extractSessionKey, fetchWebUsage } from "./cookie-reader.js"
import { detectClaude, probeCLIUsage, probeStatus } from "./cli-probe.js"
import type { UsageState, OAuthUsageResponse, ProfileResponse, AuthMethod } from "./types.js"

interface FetchResult {
  usage: OAuthUsageResponse | null
  profile: ProfileResponse | null
  authMethod: AuthMethod
}

/**
 * Fetch Claude usage data via 4-step fallback chain:
 * 1. OAuth API (only if user:profile scope available)
 * 2. Claude CLI PTY probe (primary for most users)
 * 3. Browser cookies (Chrome/Firefox)
 * 4. Failure → authMethod "none"
 *
 * Never throws. Always returns a FetchResult.
 */
export async function fetchUsageData(): Promise<FetchResult> {
  // ── Step 1: OAuth (only if user:profile scope) ──────────────────────
  try {
    const credentials = await readKeychainCredentials()
    if (credentials?.hasProfileScope) {
      const [usage, profile] = await Promise.all([
        fetchOAuthUsage(credentials.accessToken),
        fetchOAuthProfile(credentials.accessToken),
      ])
      if (usage) {
        return { usage, profile, authMethod: "oauth" }
      }
    }
    // No profile scope or OAuth failed → continue to CLI probe
  } catch {
    // continue
  }

  // ── Step 2: CLI PTY probe (primary for most users) ──────────────────
  try {
    const installed = await detectClaude()
    if (installed) {
      const [probeResult, statusResult] = await Promise.all([
        probeCLIUsage(),
        probeStatus(),
      ])

      if (probeResult) {
        // Map CLIProbeResult → OAuthUsageResponse (best-effort)
        const usage: OAuthUsageResponse = {
          fiveHour: probeResult.sessionPercent !== null
            ? { utilization: probeResult.sessionPercent, resetsAt: null }
            : null,
          sevenDay: probeResult.weeklyPercent !== null
            ? { utilization: probeResult.weeklyPercent, resetsAt: null }
            : null,
          sevenDaySonnet: probeResult.sonnetPercent !== null
            ? { utilization: probeResult.sonnetPercent, resetsAt: null }
            : null,
          sevenDayOpus: probeResult.opusPercent !== null
            ? { utilization: probeResult.opusPercent, resetsAt: null }
            : null,
          sevenDayDesign: null,
          sevenDayRoutines: null,
          sevenDayOAuthApps: null,
          extraUsage: null,
        }

        const profile: ProfileResponse | null = statusResult
          ? {
              email: statusResult.email,
              plan: statusResult.org,
            }
          : null

        return { usage, profile, authMethod: "cli" }
      }
    }
  } catch {
    // continue
  }

  // ── Step 3: Browser cookies ──────────────────────────────────────────
  try {
    const sessionKey = await extractSessionKey()
    if (sessionKey) {
      const usage = await fetchWebUsage(sessionKey)
      if (usage) {
        return { usage, profile: null, authMethod: "cookie" }
      }
    }
  } catch {
    // continue
  }

  // ── All failed ───────────────────────────────────────────────────────
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

  async function refresh(): Promise<void> {
    if (refreshing) return
    refreshing = true

    // Set loading state (preserving previous data to avoid flicker)
    setState({
      status: "loading",
      data: null,
      profile: null,
      authMethod: "none",
      error: null,
    })

    try {
      const result = await fetchUsageData()

      if (result.authMethod === "none") {
        setState({
          status: "not-configured",
          data: null,
          profile: null,
          authMethod: "none",
          error: null,
        })
      } else {
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
        status: "error",
        data: null,
        profile: null,
        authMethod: "none",
        error: String(err),
      })
    } finally {
      refreshing = false
    }
  }

  return {
    start() {
      // Initial fetch immediately
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

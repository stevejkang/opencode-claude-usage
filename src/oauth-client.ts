import type { OAuthUsageResponse, OAuthUsageResult, ProfileResponse } from "./types"

const BASE_URL = "https://api.anthropic.com"
const BETA_HEADER = "oauth-2025-04-20"
const USER_AGENT = "claude-code/2.1.0"
const TIMEOUT_MS = 10_000

function makeHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "anthropic-beta": BETA_HEADER,
    "User-Agent": USER_AGENT,
  }
}

async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    return response
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Recursively convert snake_case keys to camelCase.
 * e.g. five_hour → fiveHour, resets_at → resetsAt
 */
export function snakeToCamel(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(snakeToCamel)
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
      result[camelKey] = snakeToCamel(value)
    }
    return result
  }
  return obj
}

function normalizeWindow(w: unknown): unknown {
  if (w === null || typeof w !== "object") return w
  const obj = w as Record<string, unknown>
  if (obj.utilization === undefined && typeof obj.usedPercentage === "number") {
    obj.utilization = obj.usedPercentage
  }
  return obj
}

function normalizeUsageResponse(raw: Record<string, unknown>): OAuthUsageResponse {
  const windowKeys = [
    "fiveHour", "sevenDay", "sevenDaySonnet", "sevenDayOpus",
    "sevenDayDesign", "sevenDayRoutines", "sevenDayOAuthApps",
  ]
  for (const key of windowKeys) {
    if (raw[key]) raw[key] = normalizeWindow(raw[key])
  }
  if (Array.isArray(raw.limits)) {
    raw.limits = (raw.limits as Record<string, unknown>[]).map((entry) => {
      if (entry.percent === undefined && typeof entry.usedPercentage === "number") {
        entry.percent = entry.usedPercentage
      }
      return entry
    })
  }
  return raw as unknown as OAuthUsageResponse
}

export async function fetchOAuthUsage(accessToken: string): Promise<OAuthUsageResult> {
  try {
    const response = await fetchWithTimeout(
      `${BASE_URL}/api/oauth/usage`,
      makeHeaders(accessToken),
    )
    if (!response) return { status: "failed" }

    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "0", 10)
      return { status: "rate_limited", retryAfterMs: retryAfter > 0 ? retryAfter * 1000 : 60_000 }
    }

    if (!response.ok) return { status: "failed" }

    const raw = await response.json() as Record<string, unknown>
    return { status: "success", data: normalizeUsageResponse(snakeToCamel(raw) as Record<string, unknown>) }
  } catch {
    return { status: "failed" }
  }
}

export async function fetchOAuthProfile(accessToken: string): Promise<ProfileResponse | null> {
  try {
    const response = await fetchWithTimeout(
      `${BASE_URL}/api/oauth/profile`,
      makeHeaders(accessToken),
    )
    if (!response || !response.ok) return null

    const raw = await response.json() as Record<string, unknown>
    const converted = snakeToCamel(raw) as Record<string, unknown>

    const account = converted.account as Record<string, unknown> | undefined
    const org = converted.organization as Record<string, unknown> | undefined

    const email = typeof account?.email === "string" ? account.email
      : typeof converted.email === "string" ? converted.email
      : null
    if (!email) return null

    const plan = typeof org?.subscriptionStatus === "string" ? org.subscriptionStatus
      : typeof converted.subscriptionType === "string" ? converted.subscriptionType
      : null

    return { email, plan }
  } catch {
    return null
  }
}

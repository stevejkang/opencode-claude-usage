/**
 * Format an ISO 8601 timestamp as a human-readable relative time string.
 * Returns "—" for null/undefined input.
 * Returns "now" for past timestamps or times less than 1 minute away.
 */
export function formatRelativeTime(isoString: string | null | undefined): string {
  if (!isoString) return "—"

  const now = Date.now()
  const target = new Date(isoString).getTime()
  const diffMs = target - now

  if (diffMs <= 0) return "now"

  const totalSeconds = Math.floor(diffMs / 1000)
  const totalMinutes = Math.floor(totalSeconds / 60)
  const totalHours = Math.floor(totalMinutes / 60)
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  const minutes = totalMinutes % 60

  if (days > 0) return `${days}d ${hours}h`
  if (totalHours > 0) return `${totalHours}h ${minutes}m`
  if (totalMinutes > 0) return `${totalMinutes}m`
  return "now"
}

/**
 * Format a utilization number (0-100) as an integer percentage string.
 * Returns "—%" for null input.
 */
export function formatPercentage(utilization: number | null | undefined): string {
  if (utilization === null || utilization === undefined) return "—%"
  return `${Math.round(utilization)}%`
}

/**
 * Format credit usage as "$X.XX / $Y.YY".
 * All values are in cents (divide by 100 for dollars).
 * Returns "—" if any value is null.
 */
export function formatCost(
  usedCents: number | null | undefined,
  limitCents: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (
    usedCents === null || usedCents === undefined ||
    limitCents === null || limitCents === undefined
  ) {
    return "—"
  }
  const symbol = currency === "USD" ? "$" : (currency ?? "$")
  const used = (usedCents / 100).toFixed(2)
  const limit = (limitCents / 100).toFixed(2)
  return `${symbol}${used} / ${symbol}${limit}`
}

/**
 * Map an OAuthUsageResponse field key to a short display label.
 */
export function windowLabel(key: string): string {
  const labels: Record<string, string> = {
    fiveHour: "5H",
    sevenDay: "7D",
    sevenDaySonnet: "Sonnet",
    sevenDayOpus: "Opus",
    sevenDayDesign: "Design",
    sevenDayRoutines: "Routines",
    sevenDayOAuthApps: "Apps",
  }
  return labels[key] ?? key
}

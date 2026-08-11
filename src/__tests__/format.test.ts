import { describe, it, expect, vi, afterEach } from "vitest"
import { formatRelativeTime, formatPercentage, formatCreditDisplay, formatBar, windowLabel, limitLabel, isLimitInactive } from "../format.js"

const FIXED_NOW = new Date("2026-08-11T06:00:00Z").getTime()

describe("formatRelativeTime", () => {
  afterEach(() => { vi.useRealTimers() })

  it("returns — for null input", () => {
    expect(formatRelativeTime(null)).toBe("—")
  })

  it("returns now for past timestamps", () => {
    vi.useFakeTimers({ now: FIXED_NOW })
    expect(formatRelativeTime("2026-08-11T05:59:00Z")).toBe("now")
  })

  it("formats minutes only when < 1 hour", () => {
    vi.useFakeTimers({ now: FIXED_NOW })
    expect(formatRelativeTime("2026-08-11T06:05:00Z")).toBe("5m")
  })

  it("formats hours and minutes when < 1 day", () => {
    vi.useFakeTimers({ now: FIXED_NOW })
    expect(formatRelativeTime("2026-08-11T07:19:00Z")).toBe("1h 19m")
  })

  it("formats days and hours when >= 1 day", () => {
    vi.useFakeTimers({ now: FIXED_NOW })
    expect(formatRelativeTime("2026-08-15T22:00:00Z")).toBe("4d 16h")
  })
})

describe("formatPercentage", () => {
  it("returns —% for null", () => {
    expect(formatPercentage(null)).toBe("—%")
  })

  it("returns —% for undefined", () => {
    expect(formatPercentage(undefined)).toBe("—%")
  })

  it("rounds decimal to integer", () => {
    expect(formatPercentage(45.7)).toBe("46%")
  })

  it("handles 0", () => {
    expect(formatPercentage(0)).toBe("0%")
  })

  it("handles 100", () => {
    expect(formatPercentage(100)).toBe("100%")
  })
})

describe("formatCreditDisplay", () => {
  it("returns null for null inputs", () => {
    expect(formatCreditDisplay(null, null, null)).toBeNull()
    expect(formatCreditDisplay(0, null, "USD")).toBeNull()
    expect(formatCreditDisplay(null, 0, "USD")).toBeNull()
  })

  it("inactive: used=0, limit=0 → bar 0%, inactive suffix", () => {
    const result = formatCreditDisplay(0, 0, "USD")!
    expect(result.usedStr).toBe("$0.00")
    expect(result.remainingStr).toBe("$0.00")
    expect(result.percent).toBe(100)
    expect(result.isInactive).toBe(true)
  })

  it("full: used=limit → full bar, $0.00 balance", () => {
    const result = formatCreditDisplay(200, 200, "USD")!
    expect(result.usedStr).toBe("$2.00")
    expect(result.remainingStr).toBe("$0.00")
    expect(result.percent).toBe(100)
    expect(result.isInactive).toBe(false)
    const bar = formatBar(result.percent)
    expect(bar.filled).toBe("██████████████")
    expect(bar.empty).toBe("")
  })

  it("partial: used < limit → partial bar, balance in suffix", () => {
    const result = formatCreditDisplay(200, 300, "USD")!
    expect(result.usedStr).toBe("$2.00")
    expect(result.remainingStr).toBe("$1.00")
    expect(result.percent).toBeCloseTo(66.67, 1)
    expect(result.isInactive).toBe(false)
    const bar = formatBar(result.percent)
    expect(bar.filled.length).toBeGreaterThan(0)
    expect(bar.empty.length).toBeGreaterThan(0)
    expect(bar.filled.length + bar.empty.length).toBe(14)
  })

  it("over limit: used > limit, remaining clamped to 0, bar clamped to full", () => {
    const result = formatCreditDisplay(15000, 10000, "USD")!
    expect(result.usedStr).toBe("$150.00")
    expect(result.remainingStr).toBe("$0.00")
    expect(result.percent).toBe(150)
    expect(result.isInactive).toBe(false)
    const bar = formatBar(result.percent)
    expect(bar.filled).toBe("██████████████")
    expect(bar.empty).toBe("")
  })

  it("zero usage with positive limit → bar 0%, balance shown", () => {
    const result = formatCreditDisplay(0, 10000, "USD")!
    expect(result.usedStr).toBe("$0.00")
    expect(result.remainingStr).toBe("$100.00")
    expect(result.percent).toBe(0)
    expect(result.isInactive).toBe(false)
    const bar = formatBar(result.percent)
    expect(bar.filled).toBe("")
    expect(bar.empty.length).toBe(14)
  })

  it("uses currency symbol from input", () => {
    const result = formatCreditDisplay(100, 500, "EUR")!
    expect(result.usedStr).toBe("EUR1.00")
    expect(result.remainingStr).toBe("EUR4.00")
  })
})

describe("windowLabel", () => {
  it("maps fiveHour → Session", () => {
    expect(windowLabel("fiveHour")).toBe("Session")
  })

  it("maps sevenDay → Weekly", () => {
    expect(windowLabel("sevenDay")).toBe("Weekly")
  })

  it("maps sevenDaySonnet → Sonnet", () => {
    expect(windowLabel("sevenDaySonnet")).toBe("Sonnet")
  })

  it("maps sevenDayOpus → Opus", () => {
    expect(windowLabel("sevenDayOpus")).toBe("Opus")
  })

  it("maps sevenDayDesign → Design", () => {
    expect(windowLabel("sevenDayDesign")).toBe("Design")
  })

  it("maps sevenDayRoutines → Routines", () => {
    expect(windowLabel("sevenDayRoutines")).toBe("Routines")
  })

  it("maps sevenDayOAuthApps → Apps", () => {
    expect(windowLabel("sevenDayOAuthApps")).toBe("Apps")
  })

  it("falls back to raw key for unknown keys", () => {
    expect(windowLabel("unknownKey")).toBe("unknownKey")
  })
})

describe("limitLabel", () => {
  it("maps session → Session", () => {
    expect(limitLabel("session", null)).toBe("Session")
  })

  it("maps weekly_all → Weekly", () => {
    expect(limitLabel("weekly_all", null)).toBe("Weekly")
  })

  it("uses scope.model.displayName when available", () => {
    expect(limitLabel("weekly_scoped", { model: { displayName: "Fable" } })).toBe("Fable")
  })

  it("prefers displayName over kind mapping", () => {
    expect(limitLabel("session", { model: { displayName: "Custom" } })).toBe("Custom")
  })

  it("falls back to raw kind for unknown kinds", () => {
    expect(limitLabel("unknown_kind", null)).toBe("unknown_kind")
  })

  it("handles scope with null model", () => {
    expect(limitLabel("session", { model: null })).toBe("Session")
  })
})

describe("isLimitInactive", () => {
  it("returns true when percent=0 and resetsAt is null", () => {
    expect(isLimitInactive(0, null)).toBe(true)
  })

  it("returns true when percent=0 and resetsAt is undefined", () => {
    expect(isLimitInactive(0, undefined)).toBe(true)
  })

  it("returns false when percent > 0 even without resetsAt", () => {
    expect(isLimitInactive(36, null)).toBe(false)
  })

  it("returns false when percent=0 but resetsAt is set", () => {
    expect(isLimitInactive(0, "2026-07-08T06:00:00Z")).toBe(false)
  })

  it("returns false when both percent > 0 and resetsAt is set", () => {
    expect(isLimitInactive(57, "2026-07-08T06:00:00Z")).toBe(false)
  })
})

describe("formatRelativeTime with CLI reset strings", () => {
  it("parses time without Resets prefix: 6:10pm (Asia/Seoul)", () => {
    const result = formatRelativeTime("6:10pm (Asia/Seoul)")
    expect(result).not.toBe("—")
    expect(result).not.toContain("Resets")
    expect(result).toMatch(/^\d+[mhd]|\bnow\b/)
  })

  it("parses time without Resets prefix: Aug 14 at 3am (Asia/Seoul)", () => {
    const result = formatRelativeTime("Aug 14 at 3am (Asia/Seoul)")
    expect(result).not.toBe("—")
    expect(result).not.toContain("Resets")
  })

  it("still parses legacy format with Resets prefix", () => {
    const result = formatRelativeTime("Resets 5pm (Asia/Seoul)")
    expect(result).not.toBe("—")
    expect(result).not.toContain("Resets")
  })

  it("returns — for unparseable strings", () => {
    expect(formatRelativeTime("garbage text")).toBe("—")
  })

  it("parses simple hour format: 5pm", () => {
    const result = formatRelativeTime("5pm")
    expect(result).not.toBe("—")
    expect(result).toMatch(/^\d+[mhd]|\bnow\b/)
  })

  it("parses hour:minute format: 3:30am", () => {
    const result = formatRelativeTime("3:30am")
    expect(result).not.toBe("—")
    expect(result).toMatch(/^\d+[mhd]|\bnow\b/)
  })
})

describe("formatBar", () => {
  it("returns all empty for null utilization", () => {
    const bar = formatBar(null)
    expect(bar.filled).toBe("")
    expect(bar.empty).toBe("░░░░░░░░░░░░░░")
  })

  it("returns all empty for 0%", () => {
    const bar = formatBar(0)
    expect(bar.filled).toBe("")
    expect(bar.empty).toBe("░░░░░░░░░░░░░░")
  })

  it("returns all filled for 100%", () => {
    const bar = formatBar(100)
    expect(bar.filled).toBe("██████████████")
    expect(bar.empty).toBe("")
  })

  it("returns partial fill for 50%", () => {
    const bar = formatBar(50)
    expect(bar.filled).toBe("███████")
    expect(bar.empty).toBe("░░░░░░░")
    expect(bar.filled.length + bar.empty.length).toBe(14)
  })

  it("clamps to 0-100 range", () => {
    const over = formatBar(150)
    expect(over.filled).toBe("██████████████")
    const under = formatBar(-10)
    expect(under.filled).toBe("")
  })
})



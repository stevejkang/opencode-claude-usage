import { describe, it, expect } from "vitest"
import { formatRelativeTime, formatPercentage, formatCost, windowLabel } from "../format.js"

describe("formatRelativeTime", () => {
  it("returns — for null input", () => {
    expect(formatRelativeTime(null)).toBe("—")
  })

  it("returns now for past timestamps", () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    expect(formatRelativeTime(past)).toBe("now")
  })

  it("formats minutes only when < 1 hour", () => {
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    expect(formatRelativeTime(future)).toBe("5m")
  })

  it("formats hours and minutes when < 1 day", () => {
    const future = new Date(Date.now() + (1 * 60 + 19) * 60 * 1000).toISOString()
    expect(formatRelativeTime(future)).toBe("1h 19m")
  })

  it("formats days and hours when >= 1 day", () => {
    const future = new Date(Date.now() + (4 * 24 + 20) * 60 * 60 * 1000).toISOString()
    expect(formatRelativeTime(future)).toBe("4d 20h")
  })
})

describe("formatPercentage", () => {
  it("returns —% for null", () => {
    expect(formatPercentage(null)).toBe("—%")
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

describe("formatCost", () => {
  it("returns — for null inputs", () => {
    expect(formatCost(null, null, null)).toBe("—")
  })

  it("converts cents to dollars with 2 decimals", () => {
    expect(formatCost(12345, 50000, "USD")).toBe("$123.45 / $500.00")
  })

  it("handles zero cost", () => {
    expect(formatCost(0, 10000, "USD")).toBe("$0.00 / $100.00")
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
})

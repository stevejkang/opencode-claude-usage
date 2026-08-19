/** @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js"
import type { TuiPlugin, TuiPluginModule, TuiSlotContext } from "@opencode-ai/plugin/tui"
import type { UsageState, PluginOptions } from "./types"
import { createRefreshLoop } from "./fetcher"
import { formatRelativeTime, formatPercentage, formatBar, formatCreditDisplay, windowLabel, limitLabel, isLimitInactive } from "./format"

const CLAUDE_ORANGE = "#E07A3A"

const WINDOW_KEYS = [
  "fiveHour",
  "sevenDay",
  "sevenDaySonnet",
  "sevenDayOpus",
  "sevenDayDesign",
  "sevenDayRoutines",
  "sevenDayOAuthApps",
] as const

type WindowKey = (typeof WINDOW_KEYS)[number]

const DEFAULT_REFRESH_INTERVAL_S = 60

const tui: TuiPlugin = async (api, rawOptions, _meta) => {
  const options = (rawOptions as PluginOptions | undefined) ?? {}
  const refreshIntervalMs = (options.refreshInterval ?? DEFAULT_REFRESH_INTERVAL_S) * 1000
  const displayMode = options.displayMode ?? "text"

  const [state, setState] = createSignal<UsageState>({
    status: "idle",
    data: null,
    profile: null,
    authMethod: "none",
    error: null,
  })
  const [open, setOpen] = createSignal(true)

  const EXPECTED_LOAD_S = 25
  const [countdown, setCountdown] = createSignal(EXPECTED_LOAD_S)
  let tickTimer: ReturnType<typeof setInterval> | null = null

  const wrappedSetState = (s: UsageState) => {
    if (s.status === "loading" && !s.data) {
      setCountdown(EXPECTED_LOAD_S)
      if (!tickTimer) {
        tickTimer = setInterval(() => {
          setCountdown((prev) => Math.max(0, prev - 1))
        }, 1000)
      }
    } else if (tickTimer) {
      clearInterval(tickTimer)
      tickTimer = null
    }
    setState(s)
  }

  const loop = createRefreshLoop(wrappedSetState, refreshIntervalMs)
  loop.start()

  api.lifecycle.onDispose(() => {
    loop.stop()
    if (tickTimer) clearInterval(tickTimer)
  })

  api.slots.register({
    order: 50,
    slots: {
      sidebar_content(ctx: TuiSlotContext, _props: unknown) {
        const t = ctx.theme.current
        const dim = options.dimColor ?? t.textMuted ?? "#546E7A"
        const fg = options.headerColor ?? t.text ?? "#EEFFFF"
        const valueFg = options.valueColor ?? "#82AAFF"

        const s = state()

        if (s.status === "not-configured") {
          if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
            return (
              <box flexDirection="column">
                <box height={1}><text fg={CLAUDE_ORANGE}><b>{"Claude Usage"}</b></text></box>
                <box height={1}><text fg={dim}>{"Token invalid or expired"}</text></box>
              </box>
            ) as any
          }
          return (
            <box flexDirection="column">
              <box height={1}><text fg={CLAUDE_ORANGE}><b>{"Claude Usage"}</b></text></box>
              <box height={1}><text fg={dim}>{"Run 'claude login'"}</text></box>
              <box height={1}><text fg={dim}>{"or set CLAUDE_CODE_OAUTH_TOKEN"}</text></box>
            </box>
          ) as any
        }

        if (s.status === "error" && !s.data) {
          return (
            <box flexDirection="column">
              <box height={1}><text fg={CLAUDE_ORANGE}><b>{"Claude Usage"}</b></text></box>
              <box height={1}>
                <text fg={dim}>{"Failed to fetch usage"}</text>
              </box>
            </box>
          ) as any
        }

        if ((s.status === "idle" || s.status === "loading") && !s.data) {
          const remaining = countdown()
          const msg = remaining > 0 ? `Loading in ${remaining}s...` : "Loading shortly..."
          return (
            <box flexDirection="column">
              <box height={1}><text fg={CLAUDE_ORANGE}><b>{"Claude Usage"}</b></text></box>
              <box height={1}>
                <text fg={dim}>{msg}</text>
              </box>
            </box>
          ) as any
        }

        const data = s.data
        const profile = s.profile
        const isOpen = open()

        const allLabels: string[] = []
        if (data) {
          if (data.limits && data.limits.length > 0) {
            allLabels.push(...data.limits.map(l => limitLabel(l.kind, l.scope)))
          } else {
            allLabels.push(...WINDOW_KEYS.filter(k => data[k as WindowKey]).map(k => windowLabel(k)))
          }
          if (data.extraUsage?.isEnabled) allLabels.push("Credit")
        }
        const maxLen = allLabels.length > 0 ? Math.max(...allLabels.map(l => l.length)) : 0
        const pad = displayMode === "bar"
          ? Math.max(maxLen + 1, 8)
          : Math.max(maxLen + 2, 9)

        const credit = data?.extraUsage?.isEnabled
          ? formatCreditDisplay(data.extraUsage.usedCredits, data.extraUsage.monthlyLimit, data.extraUsage.currency)
          : null
        const creditBar = credit ? formatBar(credit.isInactive ? 0 : credit.percent) : null
        const creditColor = credit && !credit.isInactive
          ? (credit.percent >= 80 ? CLAUDE_ORANGE : credit.percent >= 51 ? "#F0A875" : valueFg)
          : dim

        return (
          <box flexDirection="column">
            <box height={1} flexDirection="row" onMouseDown={() => setOpen(!open())}>
                <text fg={CLAUDE_ORANGE}>
                    <b>{isOpen ? "\u25BC" : "\u25B6"}{" Claude Usage"}</b>
                </text>
            </box>

            {isOpen ? (
              <box flexDirection="column">
                {profile?.email ? (
                  <box height={1}>
                    <text fg={dim}>{` ${profile.email}`}</text>
                  </box>
                ) : null}

                {profile?.email ? (
                  <box height={1}>
                    <text fg={dim}>{` via ${s.authMethod}`}</text>
                  </box>
                ) : null}

                {data ? (
                  <box flexDirection="column">
                    {data.limits && data.limits.length > 0 ? (
                      data.limits.map((limit) => {
                        const label = limitLabel(limit.kind, limit.scope)
                        const notStarted = isLimitInactive(limit.percent, limit.resetsAt)
                        const pct = limit.percent
                        const pctColor = notStarted ? dim
                          : pct >= 80 ? CLAUDE_ORANGE
                          : pct >= 51 ? "#F0A875"
                          : valueFg

                        if (notStarted) {
                          if (displayMode === "bar") {
                            const bar = formatBar(0)
                            return (
                              <box height={1} flexDirection="row">
                                <box width={pad + 1}><text fg={fg}>{` ${label}`}</text></box>
                                <text fg={dim}>{`${bar.filled}${bar.empty}${formatPercentage(0).padStart(4)} inactive`}</text>
                              </box>
                            )
                          }
                          return (
                            <box height={1} flexDirection="row">
                              <box width={pad + 1}><text fg={fg}>{` ${label}`}</text></box>
                              <text fg={dim}>{`${formatPercentage(0).padStart(5)}  inactive`}</text>
                            </box>
                          )
                        }

                        if (displayMode === "bar") {
                          const bar = formatBar(pct)
                          const resetStr = formatRelativeTime(limit.resetsAt)
                          const resetSuffix = resetStr && resetStr !== "—" ? ` (${resetStr})` : ""
                          return (
                            <box height={1} flexDirection="row">
                              <box width={pad + 1}><text fg={fg}>{` ${label}`}</text></box>
                              <text fg={pctColor}>{`${bar.filled}${bar.empty}${formatPercentage(pct).padStart(4)}`}</text>
                              <text fg={dim}>{resetSuffix}</text>
                            </box>
                          )
                        }

                        const resetStr = formatRelativeTime(limit.resetsAt)
                        return (
                          <box height={1} flexDirection="row">
                            <box width={pad + 1}><text fg={fg}>{` ${label}`}</text></box>
                            <text fg={pctColor}>{formatPercentage(pct).padStart(5)}</text>
                            <text fg={dim}>{`  resets in ${resetStr}`}</text>
                          </box>
                        )
                      })
                    ) : (
                      WINDOW_KEYS.map((key) => {
                        const w = data[key as WindowKey]
                        if (!w) return null
                        const pct = w.utilization
                        const label = windowLabel(key)
                        const pctColor = pct === null ? valueFg
                          : pct >= 80 ? CLAUDE_ORANGE
                          : pct >= 51 ? "#F0A875"
                          : valueFg

                        if (displayMode === "bar") {
                          const bar = formatBar(pct)
                          const resetStr = formatRelativeTime(w.resetsAt)
                          const resetSuffix = resetStr && resetStr !== "—" ? ` (${resetStr})` : ""
                          return (
                            <box height={1} flexDirection="row">
                              <box width={pad + 1}><text fg={fg}>{` ${label}`}</text></box>
                              <text fg={pctColor}>{`${bar.filled}${bar.empty}${formatPercentage(pct).padStart(4)}`}</text>
                              <text fg={dim}>{resetSuffix}</text>
                            </box>
                          )
                        }

                        const resetStr = formatRelativeTime(w.resetsAt)
                        return (
                          <box height={1} flexDirection="row">
                            <box width={pad + 1}><text fg={fg}>{` ${label}`}</text></box>
                            <text fg={pctColor}>{formatPercentage(pct).padStart(5)}</text>
                            <text fg={dim}>{`  resets in ${resetStr}`}</text>
                          </box>
                        )
                      })
                    )}

                    {credit && creditBar ? (
                      displayMode === "bar" ? (
                        credit.isInactive ? (
                          <box height={1} flexDirection="row">
                            <box width={pad + 1}><text fg={fg}>{` Credit`}</text></box>
                            <text fg={dim}>{`${creditBar.empty}${formatPercentage(0).padStart(4)} inactive`}</text>
                          </box>
                        ) : (
                          <box height={1} flexDirection="row">
                            <box width={pad + 1}><text fg={fg}>{` Credit`}</text></box>
                            <text fg={creditColor}>{`${creditBar.filled}${creditBar.empty}${formatPercentage(credit.percent).padStart(4)}`}</text>
                            <text fg={dim}>{` (${credit.remainingStr})`}</text>
                          </box>
                        )
                      ) : (
                        <box height={1} flexDirection="row">
                          <box width={pad + 1}><text fg={fg}>{` Credit`}</text></box>
                          <text fg={valueFg}>{credit.usedStr}</text>
                          <text fg={dim}>{`  ${credit.remainingStr} left`}</text>
                        </box>
                      )
                    ) : null}
                  </box>
                ) : null}
              </box>
            ) : null}
          </box>
        ) as any
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-claude-usage",
  tui,
}

export default plugin

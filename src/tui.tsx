/** @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { UsageState, PluginOptions } from "./types.js"
import { createRefreshLoop } from "./fetcher.js"
import { formatRelativeTime, formatPercentage, formatCost, windowLabel } from "./format.js"

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

interface SidebarContentProps {
  state: UsageState
  options: PluginOptions
  textColor?: string
  mutedColor?: string
}

export function SidebarContent(props: SidebarContentProps) {
  const dim = props.options.dimColor ?? props.mutedColor ?? "#546E7A"
  const fg = props.options.headerColor ?? props.textColor ?? "#EEFFFF"
  const valueFg = props.options.valueColor ?? "#82AAFF"

  if (props.state.status === "not-configured") {
    return (
      <box flexDirection="column">
        <box height={1}>
          <text fg={dim}>{"Run 'claude login' first"}</text>
        </box>
      </box>
    )
  }

  if (props.state.status === "error" && !props.state.data) {
    return (
      <box flexDirection="column">
        <box height={1}>
          <text fg={dim}>{"Failed to fetch usage"}</text>
        </box>
      </box>
    )
  }

  if ((props.state.status === "idle" || props.state.status === "loading") && !props.state.data) {
    return (
      <box flexDirection="column">
        <box height={1}>
          <text fg={dim}>{"Loading..."}</text>
        </box>
      </box>
    )
  }

  const data = props.state.data
  const profile = props.state.profile

  return (
    <box flexDirection="column">
      {profile?.email ? (
        <box height={1} flexDirection="row">
          <text fg={dim}>{profile.email}</text>
        </box>
      ) : null}

      {profile?.email ? (
        <box height={1} flexDirection="row">
          <text fg={dim}>{`via ${props.state.authMethod}`}</text>
        </box>
      ) : null}

      {data ? (
        <box flexDirection="column">
          {WINDOW_KEYS.map((key) => {
            const window = data[key]
            if (!window) return null
            const pct = window.utilization
            const reset = window.resetsAt
            const label = windowLabel(key)
            const pctColor = pct !== null && pct >= 80 ? "#FF5370" : valueFg
            return (
              <box id={key} height={1} flexDirection="row">
                <text fg={fg}>{label.padEnd(8)}</text>
                <text fg={pctColor}>{formatPercentage(pct).padStart(5)}</text>
                <text fg={dim}>{`  ${formatRelativeTime(reset)}`}</text>
              </box>
            )
          })}

          {data.extraUsage?.isEnabled ? (
            <box height={1} flexDirection="row">
              <text fg={fg}>{"Credit  "}</text>
              <text fg={valueFg}>
                {formatCost(data.extraUsage.usedCredits, data.extraUsage.monthlyLimit, data.extraUsage.currency)}
              </text>
            </box>
          ) : null}
        </box>
      ) : null}
    </box>
  )
}

// ── Plugin entry point ───────────────────────────────────────────────

const DEFAULT_REFRESH_INTERVAL_S = 60

const tui: TuiPlugin = async (api, rawOptions, _meta) => {
  const options = (rawOptions as PluginOptions | undefined) ?? {}
  const refreshIntervalMs = (options.refreshInterval ?? DEFAULT_REFRESH_INTERVAL_S) * 1000

  const [state, setState] = createSignal<UsageState>({
    status: "idle",
    data: null,
    profile: null,
    authMethod: "none",
    error: null,
  })

  const loop = createRefreshLoop(setState, refreshIntervalMs)
  loop.start()

  api.lifecycle.onDispose(() => {
    loop.stop()
  })

  api.slots.register({
    order: 50,
    slots: {
      sidebar_content(ctx, _props) {
        const t = ctx.theme.current
        return (
          <SidebarContent
            state={state()}
            options={options}
            textColor={t.text.toString()}
            mutedColor={t.textMuted.toString()}
          />
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-claude-usage",
  tui,
}

export default plugin

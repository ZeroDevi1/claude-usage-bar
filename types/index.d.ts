/** 四类 token 计数，顺序固定：未缓存输入、输出、缓存读、缓存写。 */
export type Mix = [number, number, number, number]

/** 一个限额窗口的最新读数。 */
export type Limit = {
  /** `five_hour`、`seven_day` 或网关的 `spend_limit`。 */
  kind: string
  /** 0–100，超限时可大于 100。 */
  percentUsed: number
  /** 窗口重置时刻，epoch 毫秒；接口未给出时缺省。 */
  resetsAt?: number
}

/** 本会话的实时数字，来自 `session.measure` 与每次模型请求的 usage。 */
export type Live = {
  ctxTokens?: number
  /** 上下文窗口大小（token）；0 表示尚无读数。 */
  ctxWindow: number
  ctxPercent?: number
  limits: Limit[]
  costUsd?: number
  /** 本会话累计：未缓存输入、输出、缓存读、缓存写。 */
  tokIn: number
  tokOut: number
  tokRead: number
  tokWrite: number
  /** 最近一次模型请求的输出速度，token/秒：输出量除以首个内容块到结束的时长。 */
  speed?: number
  /** 最近一次模型请求的首字时间：从发出请求到收到首个内容块，毫秒。 */
  ttftMs?: number
  /** 最近一次应答的模型 id，保活请求按它计价。 */
  model?: string
}

/** 状态栏的显示偏好，同时写入 `$.store` 跨会话保留（保活开关不在其中）。 */
export type View = {
  isExpanded: boolean
  tab: 'chart' | 'model'
  theme: 'auto' | 'light' | 'dark'
}

/** 用量曲线上的一点：[距窗口起点的毫秒数, 已用百分比]。 */
export type Point = [number, number]

/** 一个限额窗口的汇总；花费与 token 只统计本机账本记录到的部分。 */
export type WindowStats = {
  kind: string
  lengthMs: number
  resetsAt: number
  percentUsed: number
  /** 窗口内本机记录的花费（按 API 价）与 token 总数。 */
  usd: number
  tokens: number
  mix: Mix
  /** 各模型家族（fable/opus/sonnet/haiku/other）在窗口内用掉的 token。 */
  usedByFamily: Record<string, number>
  pts: Point[]
  /** 上一个窗口的曲线，用于对比；没有记录时缺省。 */
  prev?: Point[]
}

export type Windows = {
  fiveHour: WindowStats | null
  sevenDay: WindowStats | null
}

/** 本会话的缓存保活状态，不跨会话保留。`pings` 在每轮对话结束时清零。 */
export type Keep = {
  isOn: boolean
  pings: number
  lastAt?: number
  /** 最近一次保活请求命中的缓存 token 数。 */
  lastRead?: number
  /** 停止或异常的原因（`miss`、`api-error` 等）；正常时缺省。 */
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': {
      live: Live
      view: View
      windows: Windows
      keep: Keep
      /** 最近一次刷新的时刻，epoch 毫秒；每分钟更新，驱动倒计时重绘。 */
      now: number
    }
  }
}

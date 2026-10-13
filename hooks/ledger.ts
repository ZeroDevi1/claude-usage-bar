import type { Limit, Mix, Point, WindowStats, Windows } from '../types'
import { costOf, familyOf } from './pricing'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** 账本的时间粒度。窗口边界按桶对齐，5h 窗口的统计误差不超过一个桶。 */
const BUCKET_MS = 600_000
/** 账本保留时长：7 天窗口再留一天余量，过期的桶在下次写入时清掉。 */
const KEEP_MS = 8 * DAY
/** 同一窗口两次采样的最短间隔（百分比变化时不受此限）。 */
const SAMPLE_MS = 300_000
/** 单条曲线的点数上限，超过后隔点抽稀。 */
const MAX_POINTS = 400
/** `resetsAt` 比已记录的晚这么多才算进入了新窗口，容忍接口返回值的秒级抖动。 */
const ROLL_MS = 600_000

/** 窗口长度；只有这两种窗口有卡片。 */
export const WINDOWS: Record<'five_hour' | 'seven_day', number> = {
  five_hour: 5 * HOUR,
  seven_day: 7 * DAY,
}

/** 跨会话的用量账本：桶起点（毫秒，字符串键）→ 模型 id → 四类 token 数。 */
export type Ledger = Record<string, Record<string, Mix>>

/** 一个窗口的用量采样，点为 [epoch 毫秒, 百分比]。 */
type Track = { resetsAt: number; pts: Point[] }

/** 各窗口当前与上一个窗口的采样，按 `Limit.kind` 索引。 */
export type History = Record<string, { cur: Track; prev?: Track }>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNumbers(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every(n => typeof n === 'number' && Number.isFinite(n))
  )
}

/** 从 `$.store` 读出的值里取出形状正确的账本条目，其余丢弃。 */
export function asLedger(value: unknown): Ledger {
  const ledger: Ledger = {}
  if (!isRecord(value)) return ledger
  for (const [bucket, models] of Object.entries(value)) {
    if (!isRecord(models)) continue
    const row: Record<string, Mix> = {}
    for (const [model, mix] of Object.entries(models)) {
      if (isNumbers(mix, 4)) row[model] = mix as Mix
    }
    ledger[bucket] = row
  }

  return ledger
}

function asTrack(value: unknown): Track | undefined {
  if (!isRecord(value) || typeof value.resetsAt !== 'number') return undefined
  const pts = Array.isArray(value.pts)
    ? value.pts.filter((p): p is Point => isNumbers(p, 2))
    : []

  return { resetsAt: value.resetsAt, pts }
}

/** 从 `$.store` 读出的值里取出形状正确的采样记录。 */
export function asHistory(value: unknown): History {
  const history: History = {}
  if (!isRecord(value)) return history
  for (const [kind, entry] of Object.entries(value)) {
    const cur = isRecord(entry) ? asTrack(entry.cur) : undefined
    if (cur === undefined || !isRecord(entry)) continue
    history[kind] = { cur, prev: asTrack(entry.prev) }
  }

  return history
}

/** 把一次调用的 token 记进它所在的桶，并清掉过期的桶；返回新账本。 */
export function addUsage(
  ledger: Ledger,
  now: number,
  model: string,
  mix: Mix,
): Ledger {
  const next: Ledger = {}
  for (const [bucket, models] of Object.entries(ledger)) {
    if (Number(bucket) >= now - KEEP_MS) next[bucket] = models
  }
  const key = String(Math.floor(now / BUCKET_MS) * BUCKET_MS)
  const old = next[key]?.[model] ?? [0, 0, 0, 0]
  next[key] = {
    ...next[key],
    [model]: [old[0] + mix[0], old[1] + mix[1], old[2] + mix[2], old[3] + mix[3]],
  }

  return next
}

/**
 * 记下各窗口此刻的百分比。`resetsAt` 明显后移说明进了新窗口，当前曲线转为“上一个”。
 * @returns 新的采样记录；没有任何变化时返回原对象，调用方据此省掉一次写入。
 */
export function addSamples(
  history: History,
  now: number,
  limits: Limit[],
): History {
  let next = history
  for (const { kind, percentUsed, resetsAt } of limits) {
    if (resetsAt === undefined) continue
    const entry = next[kind]
    if (entry === undefined || resetsAt > entry.cur.resetsAt + ROLL_MS) {
      const fresh: Track = { resetsAt, pts: [[now, percentUsed]] }
      next = { ...next, [kind]: { cur: fresh, prev: entry?.cur } }
      continue
    }
    const last = entry.cur.pts.at(-1)
    const isStale = last === undefined || now - last[0] >= SAMPLE_MS
    if (!isStale && last[1] === percentUsed) continue
    let pts: Point[] = [...entry.cur.pts, [now, percentUsed]]
    if (pts.length > MAX_POINTS) pts = pts.filter((_, i) => i % 2 === 0)
    next = { ...next, [kind]: { ...entry, cur: { ...entry.cur, pts } } }
  }

  return next
}

function toOffsets(track: Track, lengthMs: number): Point[] {
  const start = track.resetsAt - lengthMs

  return track.pts
    .map(([t, pct]): Point => [t - start, pct])
    .filter(([offset]) => offset >= 0 && offset <= lengthMs)
}

function summarizeOne(
  kind: keyof typeof WINDOWS,
  limits: Limit[],
  ledger: Ledger,
  history: History,
): WindowStats | null {
  const limit = limits.find(one => one.kind === kind)
  if (limit?.resetsAt === undefined) return null
  const lengthMs = WINDOWS[kind]
  const start = limit.resetsAt - lengthMs
  const mix: Mix = [0, 0, 0, 0]
  const usedByFamily: Record<string, number> = {}
  let usd = 0
  for (const [bucket, models] of Object.entries(ledger)) {
    // 与窗口有任何重叠的桶都算进来
    if (Number(bucket) + BUCKET_MS <= start) continue
    for (const [model, one] of Object.entries(models)) {
      const total = one[0] + one[1] + one[2] + one[3]
      const family = familyOf(model)
      usedByFamily[family] = (usedByFamily[family] ?? 0) + total
      usd += costOf(model, one)
      one.forEach((n, i) => (mix[i] = (mix[i] ?? 0) + n))
    }
  }
  const entry = history[kind]

  return {
    kind,
    lengthMs,
    resetsAt: limit.resetsAt,
    percentUsed: limit.percentUsed,
    usd,
    tokens: mix[0] + mix[1] + mix[2] + mix[3],
    mix,
    usedByFamily,
    pts: entry ? toOffsets(entry.cur, lengthMs) : [],
    prev: entry?.prev ? toOffsets(entry.prev, lengthMs) : undefined,
  }
}

/** 由最新限额读数、账本和采样记录汇总出两个窗口的卡片数据。 */
export function summarize(
  limits: Limit[],
  ledger: Ledger,
  history: History,
): Windows {
  return {
    fiveHour: summarizeOne('five_hour', limits, ledger, history),
    sevenDay: summarizeOne('seven_day', limits, ledger, history),
  }
}

/** 卡片上由窗口数据和当前时刻推出的数字。金额类在账本或百分比为零时缺省。 */
export type Pace = {
  elapsedMs: number
  remainMs: number
  unit: 'h' | 'day'
  /** 按当前速度线性外推到重置时的百分比。 */
  projected: number
  /** 外推会在重置前触顶。 */
  isOver: boolean
  /** 距触顶还有多久；仅 `isOver` 时有值，已触顶为 0。 */
  hitInMs?: number
  /** 整个窗口折合的美元额度：已花 ÷ 已用比例。 */
  windowUsd?: number
  /** 至今每单位时间的平均花费。 */
  avg?: number
  /** 剩余额度摊到剩余时间的每单位花费上限。 */
  allowed?: number
}

export function pace(w: WindowStats, now: number): Pace {
  const unit = w.lengthMs > DAY ? 'day' : 'h'
  const unitMs = unit === 'day' ? DAY : HOUR
  const remainMs = Math.max(0, w.resetsAt - now)
  // 窗口刚开始时分母过小会让外推失真，至少按一分钟算
  const elapsedMs = Math.max(60_000, w.lengthMs - remainMs)
  const projected = (w.percentUsed / elapsedMs) * w.lengthMs
  const isOver = projected > 100
  const result: Pace = { elapsedMs, remainMs, unit, projected, isOver }
  if (isOver) {
    result.hitInMs =
      Math.max(0, 100 - w.percentUsed) / (w.percentUsed / elapsedMs)
  }
  if (w.usd > 0 && w.percentUsed > 0) {
    const windowUsd = w.usd / (w.percentUsed / 100)
    result.windowUsd = windowUsd
    result.avg = w.usd / (elapsedMs / unitMs)
    if (remainMs > 0) {
      result.allowed = Math.max(0, windowUsd - w.usd) / (remainMs / unitMs)
    }
  }

  return result
}

/** 曲线在某个偏移处的百分比：取该偏移之前最近的一点，之前没有点则为 0。 */
export function valueAt(pts: Point[], offset: number): number {
  let value = 0
  for (const [at, pct] of pts) {
    if (at > offset) break
    value = pct
  }

  return value
}

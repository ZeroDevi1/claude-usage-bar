import type { Mix } from '../types'

/** 每百万 token 的美元价，顺序同 Mix：输入、输出、缓存读、缓存写。 */
type Price = Mix

/**
 * 缓存写入相对输入价的倍数。
 * 取 5 分钟 TTL 的 1.25 倍；1 小时 TTL 实际为 2 倍，订阅账号的估值会因此偏低。
 */
const WRITE = 1.25

const price = (input: number, output: number, read: number): Price => [
  input,
  output,
  read,
  input * WRITE,
]

/**
 * Anthropic 一方 API 标价（2026-10 核对），按模型 id 的子串匹配，先具体后宽泛。
 * 调价后改这里；匹配不到的模型按 Opus 5.5 计。
 */
const PRICES: [RegExp, Price][] = [
  [/fable|mythos/, price(10, 50, 0.25)],
  [/opus-5-5/, price(4, 20, 0.2)],
  [/opus/, price(5, 25, 0.5)],
  [/sonnet-5/, price(2, 10, 0.2)],
  [/sonnet/, price(3, 15, 0.3)],
  [/haiku-5/, price(0.1, 0.5, 0.01)],
  [/haiku/, price(1, 5, 0.1)],
]

const FALLBACK: Price = price(4, 20, 0.2)

function priceOf(model: string): Price {
  return PRICES.find(([pattern]) => pattern.test(model))?.[1] ?? FALLBACK
}

/** 一次调用按 API 标价折算的美元数。 */
export function costOf(model: string, mix: Mix): number {
  const p = priceOf(model)

  return mix.reduce((sum, n, i) => sum + n * (p[i] ?? 0), 0) / 1e6
}

/**
 * 按给定的 token 构成，某模型每个 token 的平均美元价。
 * @param mix 四类 token 的数量，只用其比例；全为 0 时退回纯输入价。
 */
export function blendedPrice(model: string, mix: Mix): number {
  const total = mix.reduce((sum, n) => sum + n, 0)
  if (total === 0) return (priceOf(model)[0] ?? 0) / 1e6

  return costOf(model, mix) / total
}

export type Family = 'fable' | 'opus' | 'sonnet' | 'haiku' | 'other'

export function familyOf(model: string): Family {
  if (/fable|mythos/.test(model)) return 'fable'
  if (/opus/.test(model)) return 'opus'
  if (/sonnet/.test(model)) return 'sonnet'
  if (/haiku/.test(model)) return 'haiku'

  return 'other'
}

/** “By model” 视图的四行：换算时按 `id` 计价，已用量按家族归并。 */
export const MODEL_ROWS: { family: Family; name: string; id: string; color: string }[] = [
  { family: 'fable', name: 'Fable 5.1', id: 'claude-fable-5-1', color: '#7F77DD' },
  { family: 'opus', name: 'Opus 5.5', id: 'claude-opus-5-5', color: '#D85A30' },
  { family: 'sonnet', name: 'Sonnet 5.5', id: 'claude-sonnet-5-5', color: '#1D9E75' },
  { family: 'haiku', name: 'Haiku 4.5', id: 'claude-haiku-4-5', color: '#888780' },
]

export const OPUS = 'claude-opus-5-5'

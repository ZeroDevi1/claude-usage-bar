const UNITS: [number, string][] = [
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'k'],
]

/**
 * token 数的短写法。
 * @param style `full`：`168.0k`、`4.81M`；`compact`：`645k`、`137M`；`plain`：整数不带小数（`1M`）；
 *   `pill`：k 一位、M 及以上两位（`195.5k`、`23.38M`）。
 */
export function fmtTok(
  n: number,
  style: 'full' | 'compact' | 'plain' | 'pill' = 'full',
): string {
  for (const [size, unit] of UNITS) {
    if (n < size) continue
    const v = n / size
    if (style === 'plain' && Number.isInteger(v)) return `${v}${unit}`
    const digits =
      style === 'pill'
        ? unit === 'k'
          ? 1
          : 2
        : style === 'compact'
          ? v >= 100
            ? 0
            : 1
          : v >= 10
            ? 1
            : 2

    return `${v.toFixed(digits)}${unit}`
  }

  return String(Math.round(n))
}

/** 金额：100 美元以上取整并加千分位，以下保留两位。 */
export function fmtUsd(n: number): string {
  return n >= 100 ? whole(n) : `$${n.toFixed(2)}`
}

/** 速率里的金额：10 以上取整（`$24`），以下两位。 */
export function fmtRate(n: number): string {
  return n >= 10 ? whole(n) : `$${n.toFixed(2)}`
}

function whole(n: number): string {
  return `$${String(Math.round(n)).replace(/\B(?=(\d{3})+$)/g, ',')}`
}

/**
 * 时长取最大的两个单位。
 * @param sep 两个单位之间的分隔，胶囊里紧凑写作 `1h13m`，卡片里写作 `1h 13m`。
 */
export function fmtDur(ms: number, sep = ' '): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  if (d > 0) return `${d}d${sep}${h}h`
  if (h > 0) return `${h}h${sep}${m}m`

  return `${m}m`
}

/** 首字时间这类短时长：一秒以内写毫秒，以上写一位小数的秒。 */
export function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

export function fmtPct(n: number | undefined): string {
  return n === undefined ? '—' : `${Math.round(n)}%`
}

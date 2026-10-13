import type { Keep, Live, Point, View, WindowStats, Windows } from '../types'
import { fmtDur, fmtMs, fmtPct, fmtRate, fmtTok, fmtUsd } from './format'
import { pace, valueAt } from './ledger'
import { blendedPrice, MODEL_ROWS, OPUS } from './pricing'

type Theme = View['theme']

/** 颜色表：名称 → [浅色, 深色]。胶囊的 `xxBg`/`xxFg` 成对出现，Fg 同时用于图标和标签。 */
const PALETTE: Record<string, [string, string]> = {
  band: ['#EEEDE9', '#2A2A28'],
  card: ['#FFFFFF', '#1F1F1D'],
  edge: ['#C8C7C1', '#4A4A46'],
  txt: ['#1A1A18', '#EDEDE8'],
  dim: ['#6B6A65', '#A3A29B'],
  track: ['#B9B8C4', '#5A5A60'],
  good: ['#1D8A5B', '#5DCAA5'],
  bad: ['#C8261B', '#F0766C'],
  prev: ['#9A9A95', '#77776F'],
  fiveBg: ['#D3E8DB', '#1F3D2E'],
  fiveFg: ['#1D6B4A', '#7FD1A6'],
  fiveLine: ['#1D8A5B', '#5DCAA5'],
  fiveHi: ['#E3F0E8', '#1F3D2E'],
  sevenBg: ['#E4DAF4', '#382A5C'],
  sevenFg: ['#6B3FC4', '#B79CF2'],
  sevenLine: ['#6B4FD0', '#A590F0'],
  sevenHi: ['#ECE6F8', '#33285A'],
  inBg: ['#F8D9D6', '#4F2320'],
  inFg: ['#C0392B', '#F0928A'],
  outBg: ['#DCEFD2', '#24401C'],
  outFg: ['#3B8A2E', '#93D07F'],
  speedBg: ['#D2E8F6', '#173A52'],
  speedFg: ['#1E7FC2', '#7CC0EE'],
  ttftBg: ['#D0EEEA', '#123F3A'],
  ttftFg: ['#0F7B6C', '#6FD0C2'],
  cacheBg: ['#DADFF8', '#262C5C'],
  cacheFg: ['#3A4BD6', '#9AA5FF'],
  grayBg: ['#E2E2E8', '#3A3A40'],
  grayFg: ['#55555C', '#B5B5BD'],
  keepBg: ['#FBDCC8', '#50301A'],
  keepFg: ['#C2571A', '#F0A066'],
}

export type Tone =
  | 'five'
  | 'seven'
  | 'in'
  | 'out'
  | 'speed'
  | 'ttft'
  | 'cache'
  | 'gray'
  | 'keep'

type IconName =
  | 'gauge'
  | 'calendar'
  | 'rewind'
  | 'bolt'
  | 'doc'
  | 'pulse'

/** 胶囊里的一段。`label` 用强调色，`text` 用正文色（`isAlert` 时为红色）。 */
export type Seg =
  | { kind: 'icon'; name: IconName }
  | { kind: 'label'; text: string }
  | { kind: 'text'; text: string; isBold?: boolean; isAlert?: boolean }
  | { kind: 'sep' }

export type Pill = { tone: Tone; segs: Seg[] }

/** 百分比达到这个值时数字转红。 */
const ALERT_PERCENT = 80

/** 终端没有 SVG，用浅色表里的同一组颜色给文字上底色。 */
export function toneColors(tone: Tone): { bg: string; fg: string; text: string } {
  return {
    bg: PALETTE[`${tone}Bg`]?.[0] ?? '#E2E2E8',
    fg: PALETTE[`${tone}Fg`]?.[0] ?? '#55555C',
    text: PALETTE.txt?.[0] ?? '#1A1A18',
  }
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const n = (value: number): string => String(Math.round(value * 100) / 100)

function styleOf(theme: Theme): string {
  const rules = (i: 0 | 1): string =>
    Object.entries(PALETTE)
      .map(([k, v]) => `.f-${k}{fill:${v[i]}}.s-${k}{stroke:${v[i]}}`)
      .join('')
  const colors =
    theme === 'light'
      ? rules(0)
      : theme === 'dark'
        ? rules(1)
        : `${rules(0)}@media (prefers-color-scheme:dark){${rules(1)}}`

  return `<style>${colors}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.sans{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}</style>`
}

function svg(width: number, height: number, theme: Theme, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="0 0 ${n(width)} ${n(height)}">${styleOf(theme)}${body}</svg>`
}

/** 16×16 网格里的线条图标；`c` 是调色板名，描边与填充都取它。 */
function icon(name: IconName, c: string): string {
  const s = `class="s-${c}" fill="none"`
  const f = `class="f-${c}" stroke="none"`
  switch (name) {
    case 'gauge':
      return `<path ${s} d="M2.6 11.5a5.8 5.8 0 1 1 10.8 0M8 9.6l2.8-3.6"/><circle ${f} cx="8" cy="9.6" r="1.1"/>`
    case 'calendar':
      return `<rect ${s} x="2.3" y="3.4" width="11.4" height="10.2" rx="2"/><path ${s} d="M2.3 6.8h11.4M5.4 1.8v3M10.6 1.8v3"/><circle ${f} cx="8" cy="10.2" r="1.1"/>`
    case 'rewind':
      return `<path ${s} d="M3 8a5 5 0 1 0 1.6-3.7M2.6 2.4v2.4H5M8 5.4V8l1.9 1.4"/>`
    case 'bolt':
      return `<path ${f} d="M9.2 1.2 3.4 9.1h3.9l-.9 5.7 5.9-8h-4z"/>`
    case 'doc':
      return `<rect ${s} x="3.2" y="1.8" width="9.6" height="12.4" rx="1.6"/><path ${s} d="M5.6 5.2h4.8M5.6 8h4.8M5.6 10.8h3"/>`
    case 'pulse':
      return `<path ${s} d="M1.4 8h3.2l1.7-4.2 3.2 8.4L11.2 8h3.4"/>`
  }
}

/** 胶囊高度与等宽字号，px。 */
const PILL_H = 20
const PILL_FONT = 11
/** 同一行相邻胶囊的间距。 */
const PILL_BETWEEN = 6

/** 灰底容器的内边距与行距。 */
const INSET = 9
const LINE_GAP = 7
/** 一行排不下时折行的宽度上限；再宽就会被界面整体缩小，字看不清。 */
const MAX_WIDTH = 780

/** 等宽字体的字宽与字号之比；文字用 textLength 钉死宽度，换了字体布局也不走样。 */
const CHAR = 0.6

function segWidth(seg: Seg): number {
  switch (seg.kind) {
    case 'icon':
      return PILL_FONT + 1.5
    case 'sep':
      return 1
    default:
      return seg.text.length * CHAR * PILL_FONT
  }
}

function drawPill(pill: Pill, x: number, y: number, width: number): string {
  const height = PILL_H
  const font = PILL_FONT
  const gap = font * 0.5
  const cy = y + height / 2
  let out = `<rect class="f-${pill.tone}Bg" x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${height}" rx="${height / 2}"/>`
  let sx = x + font * 0.8
  for (const seg of pill.segs) {
    const w = segWidth(seg)
    if (seg.kind === 'icon') {
      out += `<g transform="translate(${n(sx)} ${n(cy - w / 2)}) scale(${n(w / 16)})" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${icon(seg.name, `${pill.tone}Fg`)}</g>`
    } else if (seg.kind === 'sep') {
      out += `<rect class="f-txt" opacity=".35" x="${n(sx)}" y="${n(cy - font * 0.55)}" width="1" height="${n(font * 1.1)}"/>`
    } else {
      const color =
        seg.kind === 'label' ? `${pill.tone}Fg` : seg.isAlert ? 'bad' : 'txt'
      const weight = seg.kind === 'text' && seg.isBold ? ' font-weight="700"' : ''
      out += `<text class="mono f-${color}" x="${n(sx)}" y="${n(cy + font * 0.35)}" font-size="${font}"${weight} textLength="${n(w)}" lengthAdjust="spacingAndGlyphs">${esc(seg.text)}</text>`
    }
    sx += w + gap
  }

  return out
}

/** 灰底圆角容器里的一行胶囊，排不下 MAX_WIDTH 时折行。 */
export function pillsSvg(pills: Pill[], theme: Theme): string {
  const gap = PILL_FONT * 0.5
  let x = INSET
  let y = INSET
  let widest = 0
  let body = ''
  for (const pill of pills) {
    const width =
      pill.segs.reduce((sum, seg) => sum + segWidth(seg), 0) +
      gap * (pill.segs.length - 1) +
      PILL_FONT * 1.6
    if (x > INSET && x + width > MAX_WIDTH - INSET) {
      x = INSET
      y += PILL_H + LINE_GAP
    }
    body += drawPill(pill, x, y, width)
    widest = Math.max(widest, x + width)
    x += width + PILL_BETWEEN
  }
  const width = widest + INSET
  const height = y + PILL_H + INSET

  return svg(
    width,
    height,
    theme,
    `<rect class="f-band" width="${n(width)}" height="${n(height)}" rx="10"/>${body}`,
  )
}

const LIMIT_PILLS: { kind: string; label: string; tone: Tone; icon: IconName }[] = [
  { kind: 'five_hour', label: '5h', tone: 'five', icon: 'gauge' },
  { kind: 'seven_day', label: '7d', tone: 'seven', icon: 'calendar' },
]

function percentSeg(percent: number | undefined): Seg {
  return {
    kind: 'text',
    text: fmtPct(percent),
    isBold: true,
    isAlert: (percent ?? 0) >= ALERT_PERCENT,
  }
}

function keepPill(keep: Keep, maxPings: number): Pill {
  const segs: Seg[] = [
    { kind: 'icon', name: 'pulse' },
    { kind: 'label', text: 'keep' },
    { kind: 'text', text: `${keep.pings}/${maxPings}` },
  ]
  if (keep.note !== undefined) {
    segs.push({ kind: 'text', text: keep.note, isAlert: true })
  }

  return { tone: 'keep', segs }
}

/**
 * 本会话的 token 明细：in、out、速度、首字时间、缓存与费用。
 * 速度和首字时间取最近一次模型请求；缓存胶囊依次是累计读取、累计写入、命中率、本会话费用。
 */
export function detailPills(live: Live): Pill[] {
  // 会话状态可能是旧版本写下的，缺这两个字段时按 0 算
  const read = live.tokRead || 0
  const write = live.tokWrite || 0
  const pills: Pill[] = [
    {
      tone: 'in',
      segs: [
        { kind: 'label', text: 'in' },
        { kind: 'text', text: fmtTok(live.tokIn, 'pill') },
      ],
    },
    {
      tone: 'out',
      segs: [
        { kind: 'label', text: 'out' },
        { kind: 'text', text: fmtTok(live.tokOut, 'pill') },
      ],
    },
  ]
  if (live.speed !== undefined) {
    pills.push({
      tone: 'speed',
      segs: [
        { kind: 'icon', name: 'bolt' },
        { kind: 'text', text: `~${Math.round(live.speed)} t/s` },
      ],
    })
  }
  if (live.ttftMs !== undefined) {
    pills.push({
      tone: 'ttft',
      segs: [
        { kind: 'icon', name: 'rewind' },
        { kind: 'label', text: 'ttft' },
        { kind: 'text', text: fmtMs(live.ttftMs) },
      ],
    })
  }
  const cache: Seg[] = [
    { kind: 'label', text: 'cache' },
    { kind: 'text', text: fmtTok(read, 'pill') },
    { kind: 'sep' },
    { kind: 'label', text: 'write' },
    { kind: 'text', text: fmtTok(write, 'pill') },
  ]
  // 命中率：输入侧 token 里由缓存提供的比例
  const input = live.tokIn + read + write
  if (input > 0) {
    cache.push(
      { kind: 'sep' },
      { kind: 'label', text: 'hit' },
      { kind: 'text', text: `${Math.round((read / input) * 100)}%` },
    )
  }
  if (live.costUsd !== undefined) {
    cache.push(
      { kind: 'sep' },
      { kind: 'label', text: 'cost' },
      { kind: 'text', text: fmtUsd(live.costUsd) },
    )
  }
  pills.push({ tone: 'cache', segs: cache })

  return pills
}

/** 收起时的胶囊：token 明细（含费用）；上下文与限额只在展开后显示。 */
export function collapsedPills(live: Live, keep: Keep, maxPings: number): Pill[] {
  const pills = detailPills(live)
  if (keep.isOn) pills.push(keepPill(keep, maxPings))

  return pills
}

/** 展开时卡片下面的胶囊：限额、token 明细（含费用）、上下文。 */
export function compactPills(
  live: Live,
  keep: Keep,
  now: number,
  maxPings: number,
): Pill[] {
  const pills: Pill[] = []
  for (const spec of LIMIT_PILLS) {
    const limit = live.limits.find(one => one.kind === spec.kind)
    if (limit === undefined) continue
    const segs: Seg[] = [
      { kind: 'icon', name: spec.icon },
      { kind: 'label', text: spec.label },
      percentSeg(limit.percentUsed),
    ]
    if (limit.resetsAt !== undefined) {
      segs.push(
        { kind: 'sep' },
        { kind: 'text', text: fmtDur(limit.resetsAt - now, '') },
      )
    }
    pills.push({ tone: spec.tone, segs })
  }
  pills.push(...detailPills(live))
  pills.push({
    tone: 'gray',
    segs: [
      { kind: 'icon', name: 'doc' },
      { kind: 'label', text: 'ctx' },
      percentSeg(live.ctxPercent),
    ],
  })
  if (keep.isOn) pills.push(keepPill(keep, maxPings))

  return pills
}

const CARD_W = 282
const CARD_H = 174
const CARD_GAP = 8

type TextOptions = {
  size?: number
  isBold?: boolean
  anchor?: 'end' | 'middle'
  isMono?: boolean
}

function text(
  x: number,
  y: number,
  content: string,
  color: string,
  o: TextOptions = {},
): string {
  return `<text class="${o.isMono ? 'mono' : 'sans'} f-${color}" x="${n(x)}" y="${n(y)}" font-size="${o.size ?? 11}"${o.isBold ? ' font-weight="700"' : ''}${o.anchor ? ` text-anchor="${o.anchor}"` : ''}>${esc(content)}</text>`
}

type CardSpec = { label: string; tone: 'five' | 'seven'; prevLabel: string }

function cardHead(x0: number, spec: CardSpec, w: WindowStats, windowUsd?: number): string {
  const title =
    windowUsd === undefined
      ? `${spec.label} window`
      : `${spec.label} window ≈ ${fmtUsd(windowUsd)} at API prices`
  const spent =
    w.usd > 0
      ? `${fmtUsd(w.usd)} · ${fmtTok(w.tokens)} tokens`
      : 'no usage recorded on this machine yet'

  return (
    text(x0 + 14, 26, title, 'txt', { size: 13.5, isBold: true }) +
    text(x0 + 14, 43, `used ${Math.round(w.percentUsed)}% · ${spent}`, 'dim', {
      size: 10.5,
    })
  )
}

function linePath(points: [number, number][]): string {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${n(x)} ${n(y)}`).join('')
}

/** “Chart” 视图：节奏判断、两行速率、用量曲线与上一窗口的对比。 */
function chartCard(x0: number, spec: CardSpec, w: WindowStats, now: number): string {
  const p = pace(w, now)
  const line = `${spec.tone}Line`
  const right = x0 + CARD_W - 14
  const per = `/${p.unit}`
  let out = cardHead(x0, spec, w, p.windowUsd)

  // 标题行：左边是结论，右边是时间
  const isHit = w.percentUsed >= 100
  const headline = isHit
    ? `<tspan class="f-bad">Limit reached</tspan>`
    : p.isOver
      ? `<tspan class="f-bad">Limit hit in ${fmtDur(p.hitInMs ?? 0)}</tspan>`
      : `<tspan class="f-txt">On pace to finish at</tspan><tspan class="f-good" dx="3.5">${Math.round(p.projected)}%</tspan>`
  const timing = isHit
    ? `resets in ${fmtDur(p.remainMs)}`
    : p.isOver
      ? `${fmtDur(p.remainMs - (p.hitInMs ?? 0))} before reset`
      : `reset in ${fmtDur(p.remainMs)}`
  out += `<text class="sans" x="${x0 + 14}" y="66" font-size="11.5" font-weight="700">${headline}</text>`
  out += text(right, 66, timing, p.isOver || isHit ? 'bad' : 'good', {
    size: 10,
    isBold: true,
    anchor: 'end',
  })
  out += `<rect class="f-txt" x="${x0 + 14}" y="72" width="${CARD_W - 28}" height="1"/>`

  // 两行速率：至今平均，以及剩余额度允许的上限
  const opus = (usd: number | undefined): string =>
    usd === undefined
      ? ''
      : `≈ ${fmtTok(usd / blendedPrice(OPUS, w.mix), 'compact')} Opus`
  const rate = (usd: number | undefined): string =>
    usd === undefined ? '—' : `${fmtRate(usd)}${per}`
  out += `<rect class="f-${spec.tone}Hi" x="${x0 + 8}" y="94" width="${CARD_W - 16}" height="19" rx="5"/>`
  out += text(x0 + 14, 88, 'Average so far', 'txt')
  out += text(x0 + 196, 88, rate(p.avg), 'txt', { size: 12, anchor: 'end' })
  out += text(right, 88, opus(p.avg), 'dim', { size: 9.5, anchor: 'end' })
  out += text(x0 + 14, 107, p.isOver ? 'Slow down to' : 'Spend up to', 'txt')
  out += text(x0 + 196, 107, rate(p.allowed), p.isOver ? 'bad' : 'txt', {
    size: 12,
    isBold: true,
    anchor: 'end',
  })
  out += text(right, 107, opus(p.allowed), 'dim', { size: 9.5, anchor: 'end' })

  // 曲线：横轴是整个窗口，纵轴 0–100%，略高于 100% 的部分截平
  const left = x0 + 14
  const plotRight = x0 + CARD_W - 44
  const base = 152
  const top = 124
  const X = (offset: number): number =>
    left + (Math.min(w.lengthMs, Math.max(0, offset)) / w.lengthMs) * (plotRight - left)
  const Y = (pct: number): number =>
    base - (Math.min(112, Math.max(0, pct)) / 100) * (base - top)
  const toXY = (pts: Point[]): [number, number][] => [
    [X(0), Y(0)],
    ...pts.map(([at, pct]): [number, number] => [X(at), Y(pct)]),
  ]
  const nowXY: [number, number] = [X(p.elapsedMs), Y(w.percentUsed)]
  const actual = [...toXY(w.pts.filter(([at]) => at < p.elapsedMs)), nowXY]
  if (w.prev !== undefined && w.prev.length > 0) {
    out += `<path class="s-prev" fill="none" stroke-width="1.2" d="${linePath(toXY(w.prev))}"/>`
  }
  out += `<path class="f-${line}" opacity=".16" d="${linePath(actual)}L${n(nowXY[0])} ${base}L${n(X(0))} ${base}Z"/>`
  out += `<path class="s-bad" fill="none" stroke-width="1" stroke-dasharray="2.5 2.5" d="M${left} ${top}H${plotRight}"/>`
  out += text(plotRight + 5, top + 3.5, 'limit', 'bad', { size: 10 })
  if (!isHit) {
    // 细线：恰好在重置时用完的节奏；虚线：按当前速度外推
    out += `<path class="s-${line}" fill="none" opacity=".45" stroke-width="1" d="M${n(nowXY[0])} ${n(nowXY[1])}L${n(X(w.lengthMs))} ${n(Y(100))}"/>`
    const end: [number, number] = p.isOver
      ? [X(p.elapsedMs + (p.hitInMs ?? 0)), Y(100)]
      : [X(w.lengthMs), Y(p.projected)]
    out += `<path class="s-${p.isOver ? 'bad' : line}" fill="none" stroke-width="1.6" stroke-dasharray="4 3" d="M${n(nowXY[0])} ${n(nowXY[1])}L${n(end[0])} ${n(end[1])}"/>`
    if (p.isOver) {
      out += `<circle class="f-bad" cx="${n(end[0])}" cy="${n(end[1])}" r="2.4"/>`
    }
  }
  out += `<path class="s-${line}" fill="none" stroke-width="1.8" stroke-linejoin="round" d="${linePath(actual)}"/>`
  out += `<circle class="f-${line}" cx="${n(nowXY[0])}" cy="${n(nowXY[1])}" r="2.8"/>`

  // 脚注：与上一个窗口同一进度处的对比
  if (w.prev !== undefined && w.prev.length > 0) {
    const byNow = Math.round(valueAt(w.prev, p.elapsedMs))
    const atReset = Math.round(w.prev.at(-1)?.[1] ?? 0)
    out += `<rect class="f-prev" x="${x0 + 14}" y="162.5" width="12" height="1.6"/>`
    out += text(
      x0 + 31,
      166.5,
      `${spec.prevLabel}: ${byNow}% by now, ${atReset}% at reset`,
      'dim',
      { size: 10 },
    )
  } else {
    out += text(x0 + 14, 166.5, `No previous ${spec.label} window to compare`, 'dim', {
      size: 10,
    })
  }

  return out
}

/** “By model” 视图：剩余额度若全花在某一个模型上，各能换多少 token。 */
function modelCard(x0: number, spec: CardSpec, w: WindowStats, now: number): string {
  const { windowUsd } = pace(w, now)
  const leftUsd = windowUsd === undefined ? undefined : Math.max(0, windowUsd - w.usd)
  const rows = MODEL_ROWS.map(row => ({
    ...row,
    left: leftUsd === undefined ? undefined : leftUsd / blendedPrice(row.id, w.mix),
    used: w.usedByFamily[row.family],
  }))
  const most = Math.max(1, ...rows.map(row => row.left ?? 0))
  const right = x0 + CARD_W - 14
  let out = cardHead(x0, spec, w, windowUsd)
  out += `<rect class="f-${spec.tone}Hi" x="${x0 + 168}" y="52" width="66" height="100" rx="6"/>`
  out += text(x0 + 14, 66, 'If you use only…', 'txt', { isBold: true })
  out += text(x0 + 201, 66, 'tokens left', `${spec.tone}Line`, {
    isBold: true,
    anchor: 'middle',
  })
  out += text(right, 66, 'used', 'dim', { size: 10, anchor: 'end' })
  out += `<rect class="f-txt" x="${x0 + 14}" y="72" width="${CARD_W - 28}" height="1"/>`
  rows.forEach((row, i) => {
    const y = 90 + i * 19
    const barWidth = 64
    const filled = ((row.left ?? 0) / most) * barWidth
    out += `<circle cx="${x0 + 19}" cy="${y - 4}" r="3.6" fill="${row.color}"/>`
    out += text(x0 + 29, y, row.name, 'txt', { size: 11.5 })
    out += `<rect class="f-track" opacity=".4" x="${x0 + 98}" y="${y - 6.5}" width="${barWidth}" height="5" rx="2.5"/>`
    if (filled > 0) {
      out += `<rect x="${x0 + 98}" y="${y - 6.5}" width="${n(Math.max(5, filled))}" height="5" rx="2.5" fill="${row.color}"/>`
    }
    out += text(x0 + 228, y, row.left === undefined ? '—' : fmtTok(row.left), 'txt', {
      size: 12,
      isBold: true,
      isMono: true,
      anchor: 'end',
    })
    out += text(right, y, row.used ? fmtTok(row.used) : 'none', 'dim', {
      size: 10,
      anchor: 'end',
    })
  })
  const footer =
    leftUsd === undefined
      ? 'Needs local usage in this window to estimate'
      : `Same ${fmtUsd(leftUsd)} left, spent at each model’s price`
  out += text(x0 + 14, 166.5, footer, 'dim', { size: 10 })

  return out
}

const CARDS: { key: keyof Windows; spec: CardSpec }[] = [
  { key: 'fiveHour', spec: { label: '5h', tone: 'five', prevLabel: 'Previous 5h' } },
  { key: 'sevenDay', spec: { label: '7d', tone: 'seven', prevLabel: 'Last week' } },
]

/** 并排的 5h 与 7d 两张卡片；某个窗口没有读数时那张卡片只有一句说明。 */
export function cardsSvg(
  windows: Windows,
  tab: View['tab'],
  now: number,
  theme: Theme,
): string {
  let body = ''
  CARDS.forEach(({ key, spec }, i) => {
    const x0 = i * (CARD_W + CARD_GAP)
    const w = windows[key]
    body += `<rect class="f-card s-edge" x="${x0 + 0.5}" y="0.5" width="${CARD_W - 1}" height="${CARD_H - 1}" rx="10" stroke-width="1"/>`
    if (w === null) {
      body += text(x0 + 14, 26, `${spec.label} window`, 'txt', {
        size: 13.5,
        isBold: true,
      })
      body += text(x0 + 14, 43, 'No rate-limit reading for this window yet', 'dim', {
        size: 10.5,
      })
    } else {
      body += tab === 'chart' ? chartCard(x0, spec, w, now) : modelCard(x0, spec, w, now)
    }
  })

  return svg(CARD_W * 2 + CARD_GAP, CARD_H, theme, body)
}

/** 卡片的纯文字摘要：SVG 的 alt，也是终端里展开后显示的内容。 */
export function windowLines(windows: Windows, now: number): string[] {
  return CARDS.flatMap(({ key, spec }) => {
    const w = windows[key]
    if (w === null) return []
    const p = pace(w, now)
    const head =
      p.windowUsd === undefined
        ? `${spec.label} window`
        : `${spec.label} window ≈ ${fmtUsd(p.windowUsd)}`
    const verdict =
      w.percentUsed >= 100
        ? `limit reached, resets in ${fmtDur(p.remainMs)}`
        : p.isOver
          ? `limit hit in ${fmtDur(p.hitInMs ?? 0)}, ${fmtDur(p.remainMs - (p.hitInMs ?? 0))} before reset`
          : `on pace to finish at ${Math.round(p.projected)}%, reset in ${fmtDur(p.remainMs)}`
    const rates =
      p.avg === undefined
        ? ''
        : ` · avg ${fmtRate(p.avg)}/${p.unit}` +
          (p.allowed === undefined
            ? ''
            : ` · ${p.isOver ? 'slow down to' : 'spend up to'} ${fmtRate(p.allowed)}/${p.unit}`)

    return [`${head} · used ${Math.round(w.percentUsed)}% · ${verdict}${rates}`]
  })
}

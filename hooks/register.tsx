import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage, Timer } from 'claude-code'

import type { Limit, Mix, View } from '../types'
import { addSamples, addUsage, asHistory, asLedger, summarize } from './ledger'
import { OPUS } from './pricing'
import {
  cardsSvg,
  pillsSvg,
  statusPills,
  toneColors,
  windowLines,
} from './svg'
import type { Pill } from './svg'

const live = atom({ plugin: 'usage-bar', key: 'live' } as const, {
  ctxWindow: 0,
  limits: [],
  tokIn: 0,
  tokOut: 0,
  tokRead: 0,
  tokWrite: 0,
})
const view = atom({ plugin: 'usage-bar', key: 'view' } as const, {
  isExpanded: false,
  tab: 'chart',
  theme: 'auto',
})
const windows = atom({ plugin: 'usage-bar', key: 'windows' } as const, {
  fiveHour: null,
  sevenDay: null,
})
const keep = atom({ plugin: 'usage-bar', key: 'keep' } as const, {
  isOn: false,
  pings: 0,
})
const clock = atom({ plugin: 'usage-bar', key: 'now' } as const, 0)

const COMMAND = 'usage-bar'
const HELP =
  '/usage-bar：展开或收起卡片 · /usage-bar keepalive on|off：开关本会话的缓存保活 · /usage-bar ping：立即保活一次'

/** 保活请求的提示词：只为让服务端读一遍已缓存的前缀，回复越短越省。 */
const PING_PROMPT = 'Cache keep-alive ping. Reply with exactly: ok'
/** 保活命中的缓存 token 低于此值视为前缀已过期（模型的最小可缓存前缀约 1k–4k）。 */
const MISS_BELOW = 1024
/** 短于此时长或少于此输出量的请求不计速度，避免除出离谱的数。 */
const MIN_SPEED_MS = 500
const MIN_SPEED_TOKENS = 20

const THEMES: View['theme'][] = ['auto', 'light', 'dark']

function isView(value: unknown): value is View {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>

  return (
    typeof v.isExpanded === 'boolean' &&
    (v.tab === 'chart' || v.tab === 'model') &&
    THEMES.includes(v.theme as View['theme'])
  )
}

function numberOption(value: unknown, fallback: number, min: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, value)
    : fallback
}

// 引擎要求 $ 只能传给本文件顶层声明的函数，所以辅助函数和它们共用的状态都放在模块级。
// 这些量随模块重载清零：定时器由重载后的 session.start 重新挂上，
// isBusy 在重载后按“空闲”处理，最坏情况是一轮对话中多发一次保活。

/** 保活间隔（毫秒）与每轮空闲的次数上限，register 时由用户配置填入。 */
let intervalMs = 270_000
let maxPings = 6
let keepTimer: Timer | undefined
let tickTimer: Timer | undefined
let isBusy = false
/** 保活请求进行中；期间引擎若为它触发 turn 事件，不当作用户的对话处理。 */
let isPinging = false

/** 后台任务失败时在对话里留一行，不打断正在进行的对话。 */
function report($: EngineInterface, err: unknown): void {
  $.ui.log(`usage-bar: ${err instanceof Error ? err.message : String(err)}`)
}

/** 按最新限额读数和账本重算两张卡片，并把时钟拨到现在。 */
const refresh = async ($: EngineInterface): Promise<void> => {
  const { limits } = await read($, live)
  const ledger = asLedger(await $.store.get('ledger'))
  const history = asHistory(await $.store.get('history'))
  await update($, windows, () => summarize(limits, ledger, history))
  const now = await $.clock.now()
  await update($, clock, () => now)
}

/** 接收引擎的一次度量：上下文、限额窗口、费用。 */
const applyUsage = async (
  $: EngineInterface,
  usage: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>,
): Promise<void> => {
  const limits: Limit[] = usage.rateLimits.map(one => {
    const resetsAt = one.resetsAt === undefined ? NaN : Date.parse(one.resetsAt)

    return {
      kind: one.kind,
      percentUsed: one.percentUsed,
      resetsAt: Number.isNaN(resetsAt) ? undefined : resetsAt,
    }
  })
  await update($, live, v => ({
    ...v,
    ctxTokens: usage.context.tokens,
    ctxWindow: usage.context.window,
    ctxPercent: usage.context.percent,
    limits,
    costUsd: usage.cost?.usd ?? v.costUsd,
  }))
  const history = asHistory(await $.store.get('history'))
  const sampled = addSamples(history, await $.clock.now(), limits)
  if (sampled !== history) await $.store.set('history', sampled)
  await refresh($)
}

/** 一次流式请求的计时。没有收到任何内容块（请求失败、被打断）时两项都缺省。 */
type Timing = {
  /** 首字时间：发出请求到首个内容块。 */
  ttftMs?: number
  /** 生成时长：首个内容块到流结束。 */
  genMs?: number
}

/**
 * 把一次模型调用记入本会话累计和跨会话账本。
 * @param timing 流式请求的计时；生成时长足够长时更新速度。保活请求不传，不影响这两项读数。
 */
const account = async (
  $: EngineInterface,
  model: string,
  mix: Mix,
  timing: Timing = {},
): Promise<void> => {
  const { genMs, ttftMs } = timing
  const isTimed =
    genMs !== undefined && genMs >= MIN_SPEED_MS && mix[1] >= MIN_SPEED_TOKENS
  await update($, live, v => ({
    ...v,
    tokIn: v.tokIn + mix[0],
    tokOut: v.tokOut + mix[1],
    // 会话状态可能是旧版本写下的，缺这两个字段时从 0 起算
    tokRead: (v.tokRead || 0) + mix[2],
    tokWrite: (v.tokWrite || 0) + mix[3],
    speed: isTimed ? mix[1] / (genMs / 1000) : v.speed,
    ttftMs: ttftMs ?? v.ttftMs,
    model,
  }))
  // 读改写之间没有锁：两个会话同时写时后写的会盖掉先写的那一笔，估值因此略偏低
  const ledger = asLedger(await $.store.get('ledger'))
  await $.store.set('ledger', addUsage(ledger, await $.clock.now(), model, mix))
  await refresh($)
}

const arm = ($: EngineInterface): void => {
  keepTimer?.cancel()
  keepTimer = $.clock.after(intervalMs, () => {
    void ping($, false).catch(err => report($, err))
  })
}

/**
 * 发一次缓存保活：在会话已缓存的前缀后追加一句极短的提问，命中即刷新 TTL。
 * 定时触发时受开关、忙碌状态和次数上限约束，成功后自己挂下一次；失败则停到下一轮对话。
 * @param isManual 来自 `/usage-bar ping`：不看开关和次数上限，也不续挂定时器。
 * @returns 给命令输出用的一句结果。
 */
const ping = async ($: EngineInterface, isManual: boolean): Promise<string> => {
  const state = await read($, keep)
  if (isBusy) return '对话进行中，缓存本来就是热的，未发送保活。'
  if (!isManual && (!state.isOn || state.pings >= maxPings)) return ''
  isPinging = true
  const result = await $.model.fork({ prompt: PING_PROMPT }).finally(() => {
    isPinging = false
  })
  if (!result.isAnswered && result.reason === 'nothing-to-fork') {
    await update($, keep, k => ({ ...k, note: undefined }))

    return '会话还没有任何应答，没有可保活的缓存。'
  }
  const { usage } = result
  const { model = OPUS } = await read($, live)
  await account($, model, [
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_read_input_tokens,
    usage.cache_creation_input_tokens,
  ])
  const lastAt = await $.clock.now()
  if (!result.isAnswered) {
    await update($, keep, k => ({ ...k, lastAt, note: result.reason }))

    return `保活请求失败：${result.reason}。`
  }
  const lastRead = usage.cache_read_input_tokens
  const isMiss = lastRead < MISS_BELOW
  await update($, keep, k => ({
    ...k,
    pings: k.pings + 1,
    lastAt,
    lastRead,
    note: isMiss ? 'miss' : undefined,
  }))
  if (!isManual && !isBusy) arm($)

  return isMiss
    ? '保活请求没有命中缓存（已过期），本次按全价重建了缓存；请调小保活间隔。'
    : `保活成功，命中缓存 ${lastRead} token。`
}

/** 开关本会话的保活。开关只存在会话状态里：新会话默认关闭，各会话互不影响。 */
const setKeep = async ($: EngineInterface, isOn: boolean): Promise<void> => {
  await update($, keep, k => ({ ...k, isOn, pings: 0, note: undefined }))
  keepTimer?.cancel()
  if (isOn && !isBusy) arm($)
}

const setView = async (
  $: EngineInterface,
  change: (v: View) => View,
): Promise<void> => {
  await $.store.set('view', await update($, view, change))
}

export const register: Register = (on, options) => {
  intervalMs = numberOption(options.keepAliveMinutes, 4.5, 0.5) * 60_000
  maxPings = Math.round(numberOption(options.keepAliveMaxPings, 6, 1))

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: '用量状态栏：展开/收起卡片，开关或手动触发缓存保活',
      argumentHint: '[keepalive on|off | ping]',
    })
    const savedView = await $.store.get('view')
    if (isView(savedView)) await update($, view, () => savedView)
    // 模块重载也会走到这里；会话状态里的保活开关还在，定时器要按它重新挂上
    const { isOn } = await read($, keep)
    await applyUsage($, await $.session.usage())

    // 每分钟拨一次时钟，让倒计时在空闲时也往前走
    tickTimer?.cancel()
    tickTimer = $.clock.every(60_000, () => {
      void $.clock
        .now()
        .then(now => update($, clock, () => now))
        .catch(err => report($, err))
    })
    if (isOn) arm($)

    return next(e)
  })

  on('session.end', ($, e, next) => {
    keepTimer?.cancel()
    tickTimer?.cancel()

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await applyUsage($, e)

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (!isPinging) {
      isBusy = true
      keepTimer?.cancel()
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // 子代理的回合结束不代表会话空闲，只认主循环的
    if (e.agentId === undefined && !isPinging) {
      isBusy = false
      const state = await update($, keep, k => ({ ...k, pings: 0, note: undefined }))
      if (state.isOn) arm($)
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // 逐块转交并记下首个内容块的时刻；engine 块是信封和标记，不算内容
    const startedAt = Date.now()
    let firstAt: number | undefined
    const stream = next(e)
    for await (const chunk of stream) {
      if (firstAt === undefined && chunk.kind !== 'engine') firstAt = Date.now()
      yield chunk
    }
    const response = await stream.result
    const { usage } = response
    if (usage !== null) {
      // 不等记账完成就把应答交还引擎；记账失败只留一行日志
      void account(
        $,
        usage.model,
        [
          usage.input_tokens,
          usage.output_tokens,
          usage.cache_read_input_tokens,
          usage.cache_creation_input_tokens,
        ],
        firstAt === undefined
          ? {}
          : { ttftMs: firstAt - startedAt, genMs: Date.now() - firstAt },
      ).catch(err => report($, err))
    }

    return response
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === '') {
      await setView($, v => ({ ...v, isExpanded: !v.isExpanded }))

      return { text: '已切换用量卡片。' }
    }
    if (arg === 'keepalive on' || arg === 'keepalive off') {
      const isOn = arg.endsWith('on')
      await setKeep($, isOn)

      return {
        text: isOn
          ? `本会话的缓存保活已开启：空闲每 ${intervalMs / 60_000} 分钟一次，每轮最多 ${maxPings} 次。`
          : '本会话的缓存保活已关闭。',
      }
    }
    if (arg === 'ping') return { text: await ping($, true) }

    return { text: HELP }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [figures, look, cards, keeping, ticked] = await Promise.all([
      read($, live),
      read($, view),
      read($, windows),
      read($, keep),
      read($, clock),
    ])
    // session.start 之前就被要求绘制时时钟还是 0，退回本地时间
    const now = ticked || Date.now()
    const pills = statusPills(figures, keeping, maxPings, look.isExpanded)
    const toggle = (): Promise<void> =>
      setView($, v => ({ ...v, isExpanded: !v.isExpanded }))
    const keepLabel = `Keep-alive: ${keeping.isOn ? 'on' : 'off'}`

    if (e.surface === 'terminal') {
      // 终端没有 Svg：胶囊退化为带底色的文字，卡片退化为每个窗口一行摘要
      const { Box, Button, Text } = $.ui.resolve(e)

      return (
        <Box flexDirection="column">
          {look.isExpanded &&
            windowLines(cards, now).map(line => <Text dimColor>{line}</Text>)}
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {pills.map(pill => {
              const colors = toneColors(pill.tone)

              return (
                <Text backgroundColor={colors.bg} color={colors.text}>
                  {` ${pillText(pill)} `}
                </Text>
              )
            })}
            <Button key="toggle" plain label={look.isExpanded ? '[-]' : '[+]'} onPress={toggle} />
            <Button
              key="keep"
              plain
              dimColor
              label={keepLabel}
              onPress={() => setKeep($, !keeping.isOn)}
            />
          </Box>
        </Box>
      )
    }

    const { Box, Button, Svg } = $.ui.resolve(e)
    const summary = windowLines(cards, now)

    return (
      <Box flexDirection="column" rowGap={1}>
        {look.isExpanded && (
          <Box flexDirection="row" columnGap={1} alignItems="flex-start">
            <Svg
              source={cardsSvg(cards, look.tab, now, look.theme)}
              alt={summary.join('\n') || 'No rate-limit reading yet'}
            />
            <Box flexDirection="column" rowGap={1} alignItems="flex-start">
              <Button
                key="tab-chart"
                label="Chart"
                variant={look.tab === 'chart' ? 'primary' : 'secondary'}
                onPress={() => setView($, v => ({ ...v, tab: 'chart' }))}
              />
              <Button
                key="tab-model"
                label="By model"
                variant={look.tab === 'model' ? 'primary' : 'secondary'}
                onPress={() => setView($, v => ({ ...v, tab: 'model' }))}
              />
              <Button
                key="theme"
                label="◐"
                onPress={() =>
                  setView($, v => ({
                    ...v,
                    theme: THEMES[(THEMES.indexOf(v.theme) + 1) % THEMES.length] ?? 'auto',
                  }))
                }
              />
              <Button
                key="keep"
                label={keepLabel}
                variant={keeping.isOn ? 'primary' : 'secondary'}
                onPress={() => setKeep($, !keeping.isOn)}
              />
            </Box>
          </Box>
        )}
        <Box flexDirection="row" columnGap={1} alignItems="center">
          <Svg
            source={pillsSvg(pills, look.theme)}
            alt={pills.map(pillText).join(' · ')}
          />
          <Button key="toggle" label={look.isExpanded ? '📉' : '📈'} onPress={toggle} />
        </Box>
      </Box>
    )
  })
}

/** 胶囊的纯文字形式：图标略去。 */
function pillText(pill: Pill): string {
  return pill.segs
    .map(seg => {
      switch (seg.kind) {
        case 'icon':
          return ''
        case 'sep':
          return '│'
        default:
          return seg.text
      }
    })
    .filter(part => part !== '')
    .join(' ')
}

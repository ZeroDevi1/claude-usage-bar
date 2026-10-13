import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { addSamples, addUsage, pace, summarize } from '../hooks/ledger'

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 9, 13, 4)
const RESET_5H = NOW + 73 * 60_000

const USAGE = {
  startedAt: NOW - HOUR,
  context: { tokens: 168_000, window: 1_000_000, percent: 17 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 51, resetsAt: new Date(RESET_5H).toISOString() },
    {
      kind: 'seven_day',
      percentUsed: 12,
      resetsAt: new Date(NOW + 151.5 * HOUR).toISOString(),
    },
  ],
  cost: { usd: 3.05 },
}

const BAND = {
  plugin: 'usage-bar',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const START = { cwd: '/tmp', surface: 'desktop', isInteractive: true } as const

const TURN_END = {
  answer: 'done',
  durationMs: 1000,
  isAborted: false,
  turnId: 't1',
  reason: 'answer',
} as const

/** 插件之下没有引擎：由测试替它应答插件在启动和回合事件里依赖的那几样。 */
function answerEngine(on: On): void {
  on('session.usage', () => ({ value: USAGE }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
}

test('窗口节奏：51% 且还剩 1h13m 时的外推与速率', () => {
  // 账本里放一笔 Opus 5.5 的输出，按 $20/M 计正好 $90
  const ledger = addUsage({}, NOW - HOUR, 'claude-opus-5-5', [0, 4_500_000, 0, 0])
  const limits = [{ kind: 'five_hour', percentUsed: 51, resetsAt: RESET_5H }]
  const { fiveHour, sevenDay } = summarize(limits, ledger, addSamples({}, NOW, limits))
  expect(sevenDay).toBe(null)
  if (fiveHour === null) throw new Error('five_hour window missing')
  expect(Math.round(fiveHour.usd * 100)).toBe(9000)
  const p = pace(fiveHour, NOW)
  expect(Math.round(p.projected)).toBe(67)
  expect(p.isOver).toBe(false)
  expect(Math.round(p.windowUsd ?? 0)).toBe(176)
  expect(Math.round(p.avg ?? 0)).toBe(24)
  expect(Math.round(p.allowed ?? 0)).toBe(71)
})

test('窗口节奏：会在重置前触顶时给出触顶时间', () => {
  const limits = [{ kind: 'seven_day', percentUsed: 12, resetsAt: NOW + 151.5 * HOUR }]
  const { sevenDay } = summarize(limits, {}, {})
  if (sevenDay === null) throw new Error('seven_day window missing')
  const p = pace(sevenDay, NOW)
  expect(p.isOver).toBe(true)
  // 16.5h 用了 12%，剩下 88% 还要 121h
  expect(Math.round((p.hitInMs ?? 0) / HOUR)).toBe(121)
  expect(p.windowUsd).toBe(undefined)
})

test('过期的桶在写入时被清掉，窗口外的用量不计入', () => {
  const old = addUsage({}, NOW - 9 * 24 * HOUR, 'claude-opus-5-5', [1, 1, 1, 1])
  const ledger = addUsage(old, NOW - 6 * HOUR, 'claude-sonnet-5-5', [0, 1_000_000, 0, 0])
  expect(Object.keys(addUsage(ledger, NOW, 'claude-opus-5-5', [0, 0, 0, 0]))).toHaveLength(2)
  const limits = [{ kind: 'five_hour', percentUsed: 10, resetsAt: RESET_5H }]
  expect(summarize(limits, ledger, {}).fiveHour?.usd).toBe(0)
})

test('状态栏在各表面都能画出，并能展开成卡片', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  answerEngine(on)
  await $.session.start(START)

  for (const surface of ['desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const pills = await ui.find({ type: 'Svg' })
    // 胶囊行只有 token 明细和费用，展开与否都一样；上下文不显示，限额只在卡片里
    expect(String(pills?.props.source)).toContain('>$3.05<')
    expect(String(pills?.props.source)).not.toContain('>17%<')
    expect(await ui.find({ key: 'tab-chart' })).toBe(undefined)

    await ui.press({ key: 'toggle' })
    const [cards, expanded] = await ui.findAll({ type: 'Svg' })
    expect(expanded?.props.source).toBe(pills?.props.source)
    // 一行胶囊高 20，上下各留 9；折成两行时高度会变成 65
    expect(String(expanded?.props.source)).toContain('height="38"')
    expect(String(cards?.props.source)).toContain('On pace to finish at')
    await ui.press({ key: 'tab-model' })
    expect(String((await ui.find({ type: 'Svg' }))?.props.source)).toContain('tokens left')
    expect((await ui.find({ key: 'tab-model' }))?.props.variant).toBe('primary')

    // 视图状态属于会话，换下一个表面前拨回初始
    await ui.press({ key: 'tab-chart' })
    await ui.press({ key: 'toggle' })
    await ui.unmount()
  }

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await terminal.find({ type: 'Text', text: /\$3\.05/ })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: /51%/ })).toBe(undefined)
  await terminal.press({ key: 'toggle' })
  expect(await terminal.find({ type: 'Text', text: /51%/ })).toBeDefined()
  await terminal.press({ key: 'toggle' })
  await terminal.unmount()
})

test('模型请求的 usage 计入本会话累计，并记下首字时间', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  answerEngine(on)
  on('turn.step', async function* (_, e) {
    yield { kind: 'text', index: 0, text: 'ok' }

    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        model: 'claude-opus-5-5',
        input_tokens: 586,
        output_tokens: 645_000,
        cache_read_input_tokens: 137_000_000,
        cache_creation_input_tokens: 3_000_000,
      },
    }
  })
  await $.session.start(START)
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of step) void _
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'toggle' })
  const source = String((await ui.findAll({ type: 'Svg' }))[1]?.props.source)
  expect(source).toContain('>586<')
  expect(source).toContain('>645.0k<')
  expect(source).toContain('>137.00M<')
  expect(source).toContain('>3.00M<')
  // 命中率 = 137M ÷ (586 + 137M + 3M)
  expect(source).toContain('>98%<')
  expect(source).toContain('>ttft<')
  await ui.unmount()
})

test(
  '保活：会话内手动开启后按间隔发送，到次数上限即停，新一轮对话开始时取消',
  { options: { keepAliveMinutes: 1, keepAliveMaxPings: 2 } },
  async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    answerEngine(on)
    let forks = 0
    on('model.fork', () => {
      forks += 1

      return {
        value: {
          isAnswered: true as const,
          text: 'ok',
          usage: {
            input_tokens: 20,
            output_tokens: 3,
            cache_read_input_tokens: 168_000,
            cache_creation_input_tokens: 0,
          },
        },
      }
    })
    await $.session.start(START)

    // 新会话默认关闭：空闲再久也不发
    await $.turn.complete(TURN_END)
    await clock.advance(180_000)
    expect(forks).toBe(0)

    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    await ui.press({ key: 'toggle' })
    await ui.press({ key: 'keep' })
    expect((await ui.find({ key: 'keep' }))?.props.label).toBe('Keep-alive: on')
    await ui.unmount()
    await $.turn.complete(TURN_END)

    await clock.advance(59_000)
    expect(forks).toBe(0)
    await clock.advance(2_000)
    expect(forks).toBe(1)
    await clock.advance(60_000)
    expect(forks).toBe(2)
    await clock.advance(180_000)
    expect(forks).toBe(2)

    // 新一轮结束后重新计数；对话进行中不发
    await $.turn.complete(TURN_END)
    await $.turn.start({ text: 'hi', turnId: 't2' })
    await clock.advance(120_000)
    expect(forks).toBe(2)
  },
)

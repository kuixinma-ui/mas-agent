import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, nextTick } from 'vue'
import { compileScript, parse } from '@vue/compiler-sfc'
import { evaluationRunStatus } from '../src/lib/evaluationStatus.js'

const live = {
  run_id: 'normal-live', mode: 'live', status: 'completed', timestamp: '2026-11-17T01:00:00Z',
  cleanup: { status: 'completed' }, budget: { stop_reason: null },
  total: 1, passed: 1, pass_rate: 1, error: 0, timeout: 0, invalid: 0, hard_fail: 0,
  cases: [{ id: 'case-1', status: 'passed', turns: [], assertions: [] }]
}

test('completed lifecycle is independent of failed case quality', () => {
  const status = evaluationRunStatus({ ...live, passed: 0, pass_rate: 0 })
  assert.equal(status.level, 'success')
  assert.equal(status.label, '运行完成')
  assert.equal(status.cleanupLabel, '清理完成')
})

test('100% case pass rate cannot hide cleanup failure', () => {
  const status = evaluationRunStatus({ ...live, cleanup: { status: 'error', type: 'OSError', message: 'Redis cleanup failed' } })
  assert.equal(status.level, 'danger')
  assert.equal(status.label, '运行失败')
  assert.match(status.reason, /清理失败.*OSError.*Redis cleanup failed/)
})

for (const [stopReason, expected] of [['model_calls', /模型调用次数.*预算/], ['deadline', /时间预算/]]) {
  test(`budget interruption explains ${stopReason} even with completed status`, () => {
    const status = evaluationRunStatus({ ...live, budget: { stop_reason: stopReason } })
    assert.equal(status.level, 'danger')
    assert.equal(status.label, '预算中断')
    assert.match(status.reason, expected)
  })
}

test('runtime failure remains visible even with completed status and cleanup', () => {
  const status = evaluationRunStatus({ ...live, runtime_error: { type: 'ConnectionError', message: 'runtime unavailable' } })
  assert.equal(status.level, 'danger')
  assert.equal(status.label, '运行失败')
  assert.match(status.reason, /ConnectionError.*runtime unavailable/)
})

test('error status with no detailed error is still a failure', () => {
  const status = evaluationRunStatus({ ...live, status: 'error' })
  assert.equal(status.level, 'danger')
  assert.match(status.reason, /未记录/)
})

for (const report of [
  { ...live, status: 'cancelled' },
  { ...live, runtime_error: { type: 'CancelledError', message: 'caller cancelled' } }
]) {
  test(`cancellation cannot appear successful: ${report.runtime_error?.type || report.status}`, () => {
    const status = evaluationRunStatus(report)
    assert.equal(status.level, 'danger')
    assert.equal(status.label, '运行取消')
    assert.match(status.reason, /取消/)
  })
}

for (const [cleanup, expectedLevel, expected] of [
  [{ status: 'rolled_back', error_type: 'ValueError' }, 'danger', /回滚.*ValueError/],
  [{ status: 'rollback_failed', errors: ['OSError'] }, 'danger', /回滚失败.*OSError/],
  [{ status: 'not_created' }, 'warning', /未创建/],
  [{ status: 'pending' }, 'warning', /尚未完成/]
]) {
  test(`cleanup ${cleanup.status} never implies normal completion`, () => {
    const status = evaluationRunStatus({ ...live, cleanup })
    assert.equal(status.level, expectedLevel)
    assert.match(`${status.reason} ${status.cleanupLabel}`, expected)
  })
}

test('legacy report without lifecycle evidence is explicitly incomplete', () => {
  const status = evaluationRunStatus({ run_id: 'legacy', mode: 'live', pass_rate: 1 })
  assert.equal(status.level, 'warning')
  assert.equal(status.label, '状态不完整')
  assert.equal(status.cleanupLabel, '清理未记录')
  assert.match(status.reason, /运行状态未记录/)
  assert.equal(evaluationRunStatus({ ...live, cleanup: null }).level, 'warning')
})

test('validation explicitly has no model calls or quality score', () => {
  const status = evaluationRunStatus({ status: 'validated', mode: 'validate' })
  assert.equal(status.isValidation, true)
  assert.equal(status.label, '校验通过')
  assert.equal(status.cleanupLabel, '清理未记录')
  assert.match(status.reason, /不调用模型.*无质量分数/)
  assert.equal(evaluationRunStatus({ mode: 'validate', status: 'error' }).isValidation, true)
})

test('deriving lifecycle never changes original report quality or error evidence', () => {
  const report = { ...live, cleanup: { status: 'error', message: '<img src=x onerror=alert(1)>' } }
  const before = JSON.stringify(report)
  evaluationRunStatus(report)
  assert.equal(JSON.stringify(report), before)
})

async function evaluationComponent() {
  const url = new URL('../src/components/EvaluationLab.vue', import.meta.url)
  const { descriptor } = parse(await readFile(url, 'utf8'), { filename: url.pathname })
  const compiled = compileScript(descriptor, { id: 'evaluation-status-test', inlineTemplate: true })
  const source = compiled.content.replace(/from (['"])([^'"]+)\1/g, (match, quote, specifier) => {
    const resolved = specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier)
    return `from ${JSON.stringify(resolved)}`
  })
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default
}

function renderer() {
  const node = (type, text = '') => ({
    type, text, props: {}, children: [], parent: null, listeners: {},
    get options() { return this.children.filter(child => child.type === 'option') },
    get selectedIndex() { return this.options.findIndex(option => option.selected) },
    set selectedIndex(index) { this.options.forEach((option, current) => { option.selected = current === index }) },
    addEventListener(name, listener) { this.listeners[name] = listener },
    removeEventListener(name) { delete this.listeners[name] }
  })
  const remove = element => {
    if (element.parent) element.parent.children.splice(element.parent.children.indexOf(element), 1)
    element.parent = null
  }
  const instance = createRenderer({
    createElement: type => node(type), createText: text => node('#text', text), createComment: () => node('#comment'),
    setText: (element, text) => { element.text = text },
    setElementText: (element, text) => { element.text = text; element.children = [] },
    patchProp: (element, key, previous, value) => {
      element.props[key] = value
      if (key === 'value') element.value = value
    },
    parentNode: element => element.parent,
    nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] || null,
    insert: (element, parent, anchor = null) => {
      remove(element); element.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index < 0) parent.children.push(element)
      else parent.children.splice(index, 0, element)
    },
    remove
  })
  return { ...instance, root: node('root') }
}

const allNodes = element => [element, ...element.children.flatMap(allNodes)]
const byClass = (element, name) => allNodes(element).filter(item => String(item.props.class || '').split(/\s+/).includes(name))
const contents = element => `${element.text}${element.children.map(contents).join('')}`
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick() }

test('real component shows shared lifecycle in history and report while retaining quality scores and escaped errors', async () => {
  const malicious = '<img src=x onerror=alert(1)>'
  const reports = [
    live,
    { ...live, run_id: 'cleanup-failure', cleanup: { status: 'error', type: 'OSError', message: malicious } },
    { ...live, run_id: 'budget-stop', status: 'error', budget: { stop_reason: 'deadline' } },
    { run_id: 'legacy-report', mode: 'live', status: 'completed', pass_rate: 1 },
    { run_id: 'validation-run', mode: 'validate', status: 'validated', validation: { case_count: 120 } }
  ]
  const originalFetch = globalThis.fetch
  globalThis.fetch = async url => {
    const path = new URL(url).pathname
    const payload = path.endsWith('/scenarios') ? { summary: { cases: 120 } }
      : path.endsWith('/runs') ? { items: reports.map(({ cases, ...summary }) => summary) }
        : reports.find(item => path.endsWith(`/runs/${item.run_id}`))
    assert.ok(payload, `unexpected API path ${path}`)
    return { ok: true, text: async () => JSON.stringify(payload) }
  }
  const view = renderer()
  const app = view.createApp(await evaluationComponent(), { baseUrl: 'http://evaluation.test' })
  try {
    app.mount(view.root)
    await settle()
    const rows = byClass(view.root, 'run-row')
    assert.equal(rows.length, 5)
    const table = allNodes(view.root).find(item => item.type === 'table')
    assert.ok(table, 'history is a readable table with labeled columns')
    assert.ok(allNodes(table).some(item => item.type === 'th' && /运行状态/.test(contents(item))))
    assert.ok(allNodes(table).some(item => item.type === 'th' && /清理状态/.test(contents(item))))
    for (const [index, label] of ['运行完成', '运行失败', '预算中断', '状态不完整', '校验通过'].entries()) {
      assert.match(contents(rows[index]), new RegExp(label))
      const button = allNodes(rows[index]).find(item => item.type === 'button')
      assert.match(button.props['aria-label'], new RegExp(reports[index].run_id))
      await button.props.onClick()
      await settle()
      const banner = byClass(view.root, 'run-lifecycle')[0]
      assert.ok(banner, 'full report must display lifecycle above its quality result')
      assert.match(contents(banner), new RegExp(label))
      if (index < 4) assert.match(contents(byClass(view.root, 'score-hero')[0]), /100\.0%/)
      if (index === 1) {
        assert.ok(String(banner.props.class).includes('danger'))
        assert.match(contents(banner), /清理失败/)
        assert.ok(contents(banner).includes(malicious))
        assert.equal(allNodes(view.root).some(item => item.type === 'img' || item.props.innerHTML != null), false)
      }
      if (index === 2) assert.match(contents(banner), /时间预算/)
      if (index === 3) assert.match(contents(banner), /清理未记录/)
      if (index === 4) {
        assert.equal(byClass(view.root, 'score-hero').length, 0)
        assert.match(contents(view.root), /没有调用模型.*没有生成质量成绩/s)
      }
    }
  } finally {
    app.unmount()
    globalThis.fetch = originalFetch
  }
})

test('comparison starts collapsed and keeps selected runs and results after toggling', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname
    let payload
    if (path.endsWith('/scenarios')) payload = { summary: { cases: 120 } }
    else if (path.endsWith('/runs')) payload = { items: [live, { ...live, run_id: 'candidate-live' }] }
    else if (path.endsWith('/compare')) {
      assert.deepEqual(JSON.parse(options.body), { left_run_id: 'normal-live', right_run_id: 'candidate-live', vary: ['retrieval'] })
      payload = { comparable: true, reason: '固定数据与裁判保持一致', deltas: { pass_rate: 0.25 } }
    } else assert.fail(`unexpected API path ${path}`)
    return { ok: true, text: async () => JSON.stringify(payload) }
  }
  const view = renderer()
  const app = view.createApp(await evaluationComponent(), { baseUrl: 'http://evaluation.test' })
  try {
    app.mount(view.root)
    await settle()
    const toggle = () => allNodes(view.root).find(item => item.type === 'button' && item.props['aria-controls'] === 'evaluation-comparison')
    const panel = () => allNodes(view.root).find(item => item.props.id === 'evaluation-comparison')
    assert.ok(toggle(), 'comparison has an accessible disclosure button')
    assert.equal(toggle().props['aria-expanded'], false)
    assert.equal(panel(), undefined, 'comparison controls start out of the focus order')

    await toggle().props.onClick()
    await settle()
    assert.equal(toggle().props['aria-expanded'], true)
    assert.ok(panel())
    const selects = allNodes(panel()).filter(item => item.type === 'select')
    selects[0].selectedIndex = 1
    selects[0].listeners.change()
    selects[1].selectedIndex = 2
    selects[1].listeners.change()
    const factor = allNodes(panel()).find(item => item.type === 'input' && item.props.value === 'retrieval')
    factor.checked = true
    factor.listeners.change()
    await settle()
    const compareButton = allNodes(panel()).find(item => item.type === 'button' && contents(item) === '比较运行')
    assert.equal(compareButton.props.disabled, false)
    await compareButton.props.onClick()
    await settle()
    assert.match(contents(panel()), /控制条件一致，可以比较.*固定数据与裁判保持一致.*pass_rate：0.2500/s)

    await toggle().props.onClick()
    await settle()
    assert.equal(toggle().props['aria-expanded'], false)
    assert.equal(panel(), undefined)
    await toggle().props.onClick()
    await settle()
    const restored = allNodes(panel()).filter(item => item.type === 'select')
    assert.equal(restored[0].options.find(item => item.props.value === 'normal-live').selected, true)
    assert.equal(restored[1].options.find(item => item.props.value === 'candidate-live').selected, true)
    assert.equal(allNodes(panel()).find(item => item.type === 'input' && item.props.value === 'retrieval').checked, true)
    assert.match(contents(panel()), /pass_rate：0.2500/)
  } finally {
    app.unmount()
    globalThis.fetch = originalFetch
  }
})

<template>
  <section class="page page-evaluation" :aria-busy="busy">
    <div class="page-heading">
      <div class="heading-copy">
        <h1>评测</h1>
        <p>验证场景，查看结果，比较每次调整。</p>
      </div>
    </div>

    <p v-if="error" role="alert" class="eval-error">{{ error }}</p>
    <div class="workspace-card eval-controls">
      <div class="eval-toolbar">
        <label>运行方式<select v-model="mode" :disabled="busy"><option value="validate">数据校验 · 不调用模型</option><option value="live">真实模型回放 · 消耗模型额度</option></select></label>
        <label>业务场景<select v-model="scenario" :disabled="busy"><option value="">全部场景</option><option v-for="(count, name) in catalog?.summary?.by_scenario || {}" :key="name" :value="name">{{ scenarioLabels[name] || name }} · {{ count }}</option></select></label>
        <label>回放条数<select v-model.number="limit" :disabled="busy"><option :value="1">1 条</option><option :value="5">5 条</option><option :value="20">20 条</option><option :value="120">全部（最多 120 条）</option></select></label>
        <button class="eval-run-button" :disabled="busy" @click="run">{{ busy ? '运行中…' : mode === 'validate' ? '校验场景数据' : '运行模型回放' }}</button>
      </div>
      <p class="eval-mode-note" :class="{ 'live-mode': mode === 'live' }">{{ mode === 'validate' ? '默认仅校验数据，不调用模型，不生成质量成绩。' : '真实模型回放将消耗模型额度，请确认场景与条数后运行。' }}</p>
      <p v-if="catalog" class="eval-caption catalog-caption">{{ catalog.id }} · v{{ catalog.version }} · {{ catalog.summary?.cases ?? catalog.summary?.total ?? catalog.cases?.length }} 条场景。当前为合成回归集，待业务审核；校验通过只表示数据可执行。</p>
    </div>

    <div v-if="report" class="evaluation-content">
      <div class="report-heading"><h2>运行报告</h2><code>{{ report.run_id }}</code></div>
      <div class="workspace-card run-lifecycle" :class="runStatus.level" :role="runStatus.level === 'danger' ? 'alert' : 'status'">
        <div><span>运行状态</span><strong>{{ runStatus.label }}</strong><small>{{ runStatus.cleanupLabel }}</small></div>
        <p v-if="runStatus.reason">{{ runStatus.reason }}</p>
      </div>
      <div v-if="runStatus.isValidation" class="workspace-card validation-result">
        <strong>{{ report.status === 'validated' ? '场景数据校验通过' : '场景数据校验未完成' }}</strong><p>校验检查格式、业务断言、知识引用与场景覆盖。本次没有调用模型，也没有生成质量成绩。</p>
        <small>运行 {{ report.run_id }} · {{ report.validation?.case_count ?? '—' }} 条数据</small>
      </div>
      <div v-else class="evaluation-summary">
        <div class="score-hero"><span>任务通过率</span><strong>{{ percent(report.pass_rate) }}</strong><small>{{ report.passed }} / {{ report.total }} 个任务，包含全部尝试</small></div>
        <div><span>不可评估</span><strong>{{ report.invalid ?? 0 }}</strong></div>
        <div><span>执行错误 / 超时</span><strong>{{ report.error ?? 0 }} / {{ report.timeout ?? 0 }}</strong></div>
        <div><span>硬性失败</span><strong class="danger">{{ report.hard_fail ?? 0 }}</strong></div>
      </div>
      <div v-if="!runStatus.isValidation" class="workspace-card">
        <div class="card-heading"><h2>逐项结果</h2><label class="inline-label"><input v-model="failedOnly" type="checkbox">只看失败与不可评估</label></div>
        <p class="eval-caption">任务通过要求所有必选断言通过。延迟与 Token 仅展示本次实际记录。</p>
        <details v-for="item in visibleCases" :key="item.case_id || item.id" class="case-row">
          <summary><span class="case-status" :class="item.status">{{ statusLabel(item.status) }}</span><strong>{{ item.case_id || item.id }}</strong><span>{{ scenarioLabels[item.scenario] || item.scenario }}</span></summary>
          <p v-if="item.error || item.reason || item.error_detail" class="eval-error">{{ item.error || item.reason || item.error_detail?.message || item.error_detail }}</p>
          <div v-for="(turn, index) in item.turns || []" :key="index" class="turn-result">
            <strong>第 {{ index + 1 }} 轮 · {{ turn.actual?.intent || turn.intent || turn.reply?.intent || turn.response?.intent || turn.status }}</strong>
            <p v-if="turn.message">{{ turn.message }}</p>
            <pre>{{ turn.actual?.response || (typeof turn.response === 'string' ? turn.response : turn.reply?.response || turn.response?.response || turn.error_detail?.message || turn.error_detail || turn.error || '') }}</pre>
          </div>
          <ul class="assertion-list"><li v-for="(check, index) in item.assertions || item.checks || []" :key="check.id || index"><b>{{ statusLabel(check.status) }}</b> {{ check.id || check.type }} — {{ check.reason || check.detail || check.message || '' }}</li></ul>
          <small>{{ item.latency_ms != null ? `${Number(item.latency_ms).toFixed(0)} ms` : '' }}</small>
        </details>
        <p v-if="!visibleCases.length" class="eval-caption">当前筛选没有结果。</p>
      </div>
    </div>

    <div class="eval-bottom">
      <section class="workspace-card history-card" aria-labelledby="evaluation-history-title">
        <div class="card-heading"><div><h2 id="evaluation-history-title">运行历史</h2><p class="eval-caption">{{ history.length }} 次运行 · 基线不会自动覆盖</p></div><button class="secondary" :disabled="busy" @click="load">刷新</button></div>
        <div v-if="history.length" class="history-scroll" role="region" aria-label="运行历史表格，可横向滚动" tabindex="0">
          <table class="history-table">
            <thead><tr><th scope="col">运行</th><th scope="col">任务通过率</th><th scope="col">运行状态</th><th scope="col">清理状态</th><th scope="col">时间</th><th scope="col"><span class="eval-sr-only">操作</span></th></tr></thead>
            <tbody>
              <tr v-for="item in historyRuns" :key="item.run_id" class="run-row">
                <td><code class="run-id" :title="item.run_id">{{ item.run_id.slice(0, 12) }}</code><small class="run-mode">{{ item.mode === 'validate' ? '数据校验' : item.mode === 'live' ? '模型回放' : item.mode || '模式未记录' }}</small></td>
                <td class="history-score">{{ item.runStatus.isValidation ? '无质量分数' : percent(item.pass_rate) }}</td>
                <td class="history-status"><strong class="run-status" :class="item.runStatus.level">{{ item.runStatus.label }}</strong><p v-if="item.runStatus.reason" class="run-reason" :class="item.runStatus.level">{{ item.runStatus.reason }}</p></td>
                <td><span class="cleanup-status">{{ item.runStatus.cleanupLabel }}</span></td>
                <td><time :datetime="item.timestamp">{{ item.timestamp || '未记录' }}</time></td>
                <td class="history-action"><button class="secondary" :disabled="busy" :aria-label="`查看运行 ${item.run_id} 的报告`" @click="openReport(item.run_id)">查看报告</button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="!history.length" class="eval-caption">运行报告将在这里保留，基线不会自动覆盖。</p>
      </section>
      <section class="workspace-card comparison-card" aria-labelledby="evaluation-comparison-title">
        <div class="card-heading comparison-heading">
          <div><h2 id="evaluation-comparison-title">配对实验比较</h2><p class="eval-caption">固定条件，查看两次运行之间的变化。</p></div>
          <button class="secondary comparison-toggle" :aria-expanded="comparisonExpanded" aria-controls="evaluation-comparison" :aria-label="comparisonExpanded ? '收起配对实验比较' : '展开配对实验比较'" @click="comparisonExpanded = !comparisonExpanded">{{ comparisonExpanded ? '收起比较' : '展开比较' }}<span aria-hidden="true">{{ comparisonExpanded ? '−' : '+' }}</span></button>
        </div>
        <div v-if="comparisonExpanded" id="evaluation-comparison" class="comparison-body">
          <div class="comparison-selects">
            <label>基准运行<select v-model="left"><option value="">选择运行</option><option v-for="item in history" :key="item.run_id" :value="item.run_id">{{ item.run_id.slice(0, 12) }} · {{ item.mode }}</option></select></label>
            <label>候选运行<select v-model="right"><option value="">选择运行</option><option v-for="item in history" :key="item.run_id" :value="item.run_id">{{ item.run_id.slice(0, 12) }} · {{ item.mode }}</option></select></label>
          </div>
          <fieldset class="factor-fieldset"><legend>本次改变的因素</legend><p class="eval-caption">数据集、知识和裁判保持一致。</p><div class="factor-list"><label v-for="(label, key) in factors" :key="key" class="inline-label"><input v-model="vary" type="checkbox" :value="key">{{ label }}</label></div></fieldset>
          <button :disabled="busy || !left || !right" @click="compare">比较运行</button>
          <div v-if="comparison" class="comparison-result" role="status"><strong>{{ comparison.comparable ? '控制条件一致，可以比较' : '本次运行不可直接比较' }}</strong><p>{{ comparison.reason }}</p><p v-for="(value, key) in comparison.deltas || {}" :key="key">{{ key }}：{{ Number(value).toFixed(4) }}</p></div>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { createEvaluationApi } from '../lib/evaluation.js'
import { evaluationRunStatus } from '../lib/evaluationStatus.js'

const props = defineProps({ baseUrl: { type: String, required: true } })
const api = computed(() => createEvaluationApi(props.baseUrl))
const catalog = ref(null), history = ref([]), report = ref(null), comparison = ref(null)
const busy = ref(false), error = ref(''), mode = ref('validate'), scenario = ref(''), limit = ref(5)
const failedOnly = ref(false), left = ref(''), right = ref(''), vary = ref([])
const comparisonExpanded = ref(false)
const factors = { code: '代码', model: '模型', prompt: '提示词', skills: '业务规则', retrieval: '检索策略' }
const scenarioLabels = { basic_routing: '基础意图分流', order_logistics: '订单与物流', billing_refund: '账单与退款', technical_security: '技术与账号安全', multi_turn: '多轮补充与更正', cross_session_memory: '跨会话记忆', handoff_safety: '人工升级与安全边界', knowledge_boundaries: '知识缺失与政策边界' }
const runStatus = computed(() => evaluationRunStatus(report.value || {}))
const historyRuns = computed(() => history.value.map(item => ({ ...item, runStatus: evaluationRunStatus(item) })))
const visibleCases = computed(() => (report.value?.cases || []).filter(item => !failedOnly.value || item.status !== 'passed'))
const percent = value => typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : '—'
const statusLabel = status => ({ passed: '通过', failed: '失败', hard_fail: '硬性失败', invalid: '不可评估', error: '错误', timeout: '超时', skipped: '未执行' }[status] || status || '—')

async function load() {
  const results = await Promise.allSettled([api.value.scenarios(), api.value.runs()])
  if (results[0].status === 'fulfilled') catalog.value = results[0].value
  if (results[1].status === 'fulfilled') history.value = results[1].value.items || results[1].value
  error.value = results.filter(item => item.status === 'rejected').map(item => item.reason.message).join('；')
}
async function run() {
  busy.value = true; error.value = ''; comparison.value = null
  try {
    report.value = await api.value.run({ mode: mode.value, limit: limit.value, ...(scenario.value ? { scenario: scenario.value } : {}) })
    await load()
  } catch (problem) { error.value = problem.message } finally { busy.value = false }
}
async function openReport(id) {
  error.value = ''
  try { report.value = await api.value.report(id) } catch (problem) { error.value = problem.message }
}
async function compare() {
  busy.value = true; error.value = ''
  try { comparison.value = await api.value.compare(left.value, right.value, vary.value) } catch (problem) { error.value = problem.message } finally { busy.value = false }
}
onMounted(load)
watch(() => props.baseUrl, () => { report.value = null; comparison.value = null; left.value = ''; right.value = ''; load() })
</script>

<style scoped>
.page-evaluation { min-width: 0; }
.page-evaluation label { display: grid; gap: 7px; margin: 0; font-size: 12px; font-weight: 500; color: var(--text-soft); }
select { width: 100%; min-width: 0; min-height: 36px; padding: 7px 28px 7px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--text); font: inherit; font-size: 13px; }
select:focus-visible, .history-scroll:focus-visible { outline: 3px solid var(--accent-soft); outline-offset: 2px; border-color: var(--accent); }
select:disabled { opacity: .6; cursor: not-allowed; }
.eval-controls { padding: 18px; }
.eval-toolbar { display: grid; grid-template-columns: minmax(210px, 1.2fr) minmax(160px, 1fr) minmax(135px, .7fr) auto; align-items: end; gap: 14px; }
.eval-run-button { min-height: 36px; white-space: nowrap; }
.eval-mode-note { margin: 14px 0 0; color: var(--text-soft); font-size: 12px; line-height: 1.6; }
.eval-mode-note.live-mode { color: var(--red); }
.eval-caption { margin: 8px 0 0; color: var(--muted); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.catalog-caption { margin-top: 6px; }
.eval-error { margin: 0; padding: 12px 14px; border-radius: 8px; color: var(--red); background: var(--red-soft); line-height: 1.7; overflow-wrap: anywhere; }
.evaluation-content { display: grid; gap: 16px; min-width: 0; }
.report-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; }
.report-heading h2 { margin: 0; font-size: 16px; font-weight: 600; }
.report-heading code { min-width: 0; color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
.run-lifecycle { border-left: 3px solid var(--green); }
.run-lifecycle > div { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.run-lifecycle span, .run-lifecycle small { color: var(--text-soft); font-size: 12px; }
.run-lifecycle strong { font-size: 14px; font-weight: 600; }
.run-lifecycle p { margin: 8px 0 0; font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.run-lifecycle.danger { border-left-color: var(--red); background: var(--red-soft); color: var(--red); }
.run-lifecycle.warning { border-left-color: var(--muted); background: var(--panel-2); color: var(--text-soft); }
.run-status { display: inline-block; padding: 4px 7px; border-radius: 5px; background: var(--green-soft); color: var(--green); font-size: 11px; font-weight: 600; white-space: nowrap; }
.run-status.danger { background: var(--red-soft); color: var(--red); }
.run-status.warning { background: var(--panel-2); color: var(--text-soft); }
.run-reason { margin: 7px 0 0; color: var(--text-soft); font-size: 11px; line-height: 1.65; overflow-wrap: anywhere; }
.run-reason.danger { color: var(--red); }
.validation-result { border-left: 3px solid var(--green); }
.validation-result > strong { font-size: 14px; font-weight: 600; }
.validation-result p, .comparison-result p { margin: 8px 0; color: var(--text-soft); font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; }
.validation-result small { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
.page-evaluation .inline-label { display: flex; align-items: center; gap: 7px; margin: 0; font-size: 12px; }
.inline-label input { width: 14px; height: 14px; margin: 0; accent-color: var(--accent); }
.case-row { padding: 14px 0; border-top: 1px solid var(--line); }
.case-row:first-of-type { margin-top: 14px; }
.case-row summary { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; cursor: pointer; list-style: none; color: var(--text-soft); font-size: 12px; overflow-wrap: anywhere; }
.case-row summary::-webkit-details-marker { display: none; }
.case-row summary::before { content: '›'; display: inline-block; color: var(--muted); font-size: 18px; }
.case-row[open] summary::before { transform: rotate(90deg); }
.case-row summary strong { color: var(--text); font-weight: 600; }
.case-row > .eval-error { margin-top: 12px; font-size: 12px; }
.case-row > small { color: var(--muted); font-size: 11px; }
.case-status { padding: 3px 7px; border-radius: 5px; background: var(--panel-2); color: var(--text-soft); font-size: 11px; }
.case-status.passed { background: var(--green-soft); color: var(--green); }
.case-status.failed, .case-status.hard_fail, .case-status.error, .case-status.timeout { background: var(--red-soft); color: var(--red); }
.case-status.invalid { background: var(--accent-soft); color: var(--accent); }
.turn-result { min-width: 0; padding: 14px; margin-top: 12px; border-radius: 8px; background: var(--panel-2); color: var(--text-soft); font-size: 12px; overflow-wrap: anywhere; }
.turn-result strong { color: var(--text); font-weight: 600; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font-family: inherit; line-height: 1.7; }
.assertion-list { padding-left: 20px; color: var(--text-soft); font-size: 12px; line-height: 1.9; overflow-wrap: anywhere; }
.eval-bottom { display: grid; gap: 18px; min-width: 0; }
.history-card, .comparison-card { min-width: 0; }
.card-heading { align-items: center; }
.card-heading .eval-caption { margin-top: 5px; }
.history-scroll { position: relative; max-width: 100%; overflow-x: auto; border-radius: 6px; }
.history-table { width: 100%; min-width: 760px; border-collapse: collapse; table-layout: fixed; text-align: left; }
.history-table th { padding: 11px 10px; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 11px; font-weight: 500; }
.history-table th:first-child { width: 130px; }
.history-table th:nth-child(2) { width: 110px; }
.history-table th:nth-child(4) { width: 110px; }
.history-table th:nth-child(5) { width: 150px; }
.history-table th:last-child { width: 104px; }
.history-table td { padding: 14px 10px; border-bottom: 1px solid var(--line); color: var(--text-soft); font-size: 12px; vertical-align: top; overflow-wrap: anywhere; }
.history-table tr:last-child td { border-bottom: 0; }
.history-table .run-id { padding: 0; border: 0; background: transparent; color: var(--text); font-size: 11px; }
.run-mode { display: block; margin-top: 5px; color: var(--muted); font-size: 11px; }
.history-table .history-score { color: var(--text); font-variant-numeric: tabular-nums; }
.cleanup-status, .history-table time { font-size: 11px; line-height: 1.6; }
.history-action { text-align: right; }
.history-action button { min-height: 30px; padding: 0 10px; font-size: 11px; white-space: nowrap; }
.comparison-heading { margin-bottom: 0; }
.comparison-toggle { display: inline-flex; align-items: center; justify-content: center; gap: 10px; white-space: nowrap; }
.comparison-toggle span { font-size: 17px; font-weight: 400; }
.comparison-body { margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--line); }
.comparison-selects { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.factor-fieldset { min-width: 0; margin: 18px 0; padding: 0; border: 0; }
.factor-fieldset legend { color: var(--text-soft); font-size: 12px; }
.factor-fieldset .eval-caption { margin: 5px 0 12px; }
.factor-list { display: flex; flex-wrap: wrap; gap: 12px 20px; }
.comparison-result { margin-top: 18px; padding: 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); }
.comparison-result strong { color: var(--text); font-size: 13px; font-weight: 600; }
.comparison-result p:last-child { margin-bottom: 0; }
.eval-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 1100px) { .eval-toolbar { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 600px) {
  .eval-controls { padding: 14px; }
  .eval-toolbar, .comparison-selects { grid-template-columns: minmax(0, 1fr); }
  .eval-toolbar { gap: 12px; }
  .comparison-heading { align-items: flex-start; flex-wrap: wrap; }
  .comparison-toggle { min-height: 32px; font-size: 12px; }
  .card-heading:has(.inline-label) { align-items: flex-start; flex-wrap: wrap; }
  .report-heading { gap: 6px; }
}
@media (pointer: coarse) {
  select { min-height: 44px; font-size: 16px; }
  .eval-run-button, .history-action button, .comparison-toggle, .history-table .run-id { min-height: 44px; }
  .case-row summary, .factor-list .inline-label { min-height: 44px; }
}
</style>

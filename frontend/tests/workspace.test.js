import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, nextTick } from 'vue'
import { compileScript, parse } from '@vue/compiler-sfc'

// Compile the actual workspace and its SFC children; only browser and HTTP
// boundaries are fake, so clicks exercise the component's real setup functions.
const modules = new Map()
async function componentModule(url) {
  if (modules.has(url.href)) return modules.get(url.href)
  let source = await readFile(url, 'utf8')
  if (url.pathname.endsWith('.vue')) {
    const { descriptor } = parse(source, { filename: url.pathname })
    source = compileScript(descriptor, { id: url.pathname, inlineTemplate: true }).content
  }
  source = source.replaceAll('import.meta.env', '({})')
  const imports = [...source.matchAll(/from (['"])([^'"]+)\1/g)]
  for (const match of imports) {
    const specifier = match[2]
    let resolved
    if (specifier.startsWith('.')) {
      const target = new URL(specifier, url)
      if (!/\.(vue|js)$/.test(target.pathname)) target.pathname += '.js'
      resolved = await componentModule(target)
    } else resolved = import.meta.resolve(specifier)
    source = source.replace(match[0], `from ${JSON.stringify(resolved)}`)
  }
  const compiled = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  modules.set(url.href, compiled)
  return compiled
}

function renderer() {
  const node = (type, text = '') => ({
    type, text, props: {}, children: [], parent: null, inputValue: '',
    style: { setProperty(key, value) { this[key] = value } },
    listeners: {},
    get tagName() { return this.type.toUpperCase() },
    get ownerDocument() { return globalThis.document },
    getRootNode() { return globalThis.document },
    get options() { return this.children.filter(child => child.type === 'option') },
    get value() { return this.type === 'select' ? this.options.find(option => option.selected)?.value ?? this.inputValue : this.inputValue },
    set value(value) { this.inputValue = value },
    get selectedIndex() { return this.options.findIndex(option => option.selected) },
    set selectedIndex(index) { this.options.forEach((option, current) => { option.selected = current === index }) },
    getBoundingClientRect: () => ({ height: 600 }),
    scrollTo() {}, focus() {},
    addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler) },
    removeEventListener(name, handler) { this.listeners[name] = (this.listeners[name] || []).filter(item => item !== handler) }
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
      if (key === 'style' && value && typeof value === 'object') Object.assign(element.style, value)
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

const contents = element => `${element.text}${element.children.map(contents).join('')}`
const allNodes = element => [element, ...element.children.flatMap(allNodes)]
const visible = element => !element || (!element.props.hidden && element.style.display !== 'none' && visible(element.parent))
const visibleContents = element => visible(element) ? `${element.text}${element.children.map(visibleContents).join('')}` : ''
const accessibleText = element => !visible(element) || [true, 'true'].includes(element.props['aria-hidden']) ? ''
  : element.props['aria-label'] || `${element.text}${element.children.map(accessibleText).join('')}`
const named = (element, name) => accessibleText(element).trim() === name
const findButton = (root, name) => allNodes(root).find(item => item.type === 'button' && visible(item) && named(item, name))
function button(root, name) {
  const result = findButton(root, name)
  assert.ok(result, `visible button named "${name}" must be available`)
  return result
}
function findField(root, label) {
  return allNodes(root).find(item => ['input', 'textarea', 'select'].includes(item.type) && visible(item) && (
    item.props['aria-label'] === label || allNodes(root).some(parent => parent.type === 'label' &&
      (parent.props.for === item.props.id && item.props.id || allNodes(parent).includes(item)) &&
      contents(parent).includes(label))
  ))
}
function field(root, label) {
  const control = findField(root, label)
  assert.ok(control, `visible form control labelled "${label}" must be available`)
  return control
}
function placeholder(root, value) {
  const control = allNodes(root).find(item => visible(item) && item.props.placeholder === value)
  assert.ok(control, `visible form control with placeholder "${value}" must be available`)
  return control
}
function configurationPanel(root) {
  let panel = button(root, '检查连接').parent
  while (panel && !(findField(panel, '用户 ID') && findField(panel, '会话 ID'))) panel = panel.parent
  assert.ok(panel, 'connection actions must be grouped with the identity controls')
  return panel
}
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick() }
async function click(element) {
  assert.ok(!element.props.disabled, 'the clicked control must be enabled')
  await element.props.onClick?.({ preventDefault() {}, stopPropagation() {} })
  await settle()
}
async function enter(element, value) {
  element.value = value
  if (element.type === 'select') {
    for (const option of element.options) option.selected = String(option.props.value) === String(value)
  }
  for (const handler of element.listeners.input || []) handler({ target: element })
  for (const handler of element.listeners.change || []) handler({ target: element })
  await element.props.onChange?.({ target: element })
  await settle()
}
async function submitFrom(element) {
  let form = element.parent
  while (form && form.type !== 'form') form = form.parent
  assert.ok(form, 'the message editor must belong to a form')
  await form.props.onSubmit({ preventDefault() {} })
  await settle()
}

async function workspace(t) {
  const originals = Object.fromEntries(['fetch', 'localStorage', 'window', 'document', 'Document', 'ShadowRoot'].map(key => [key, globalThis[key]]))
  const requests = [], unexpected = [], storage = new Map()
  globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) }
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  globalThis.Document = class Document {}
  globalThis.ShadowRoot = class ShadowRoot {}
  globalThis.document = Object.assign(new globalThis.Document(), { activeElement: null })
  globalThis.fetch = async (url, options = {}) => {
    const target = new URL(url, 'http://workspace.test')
    requests.push({ path: target.pathname, query: target.searchParams, options })
    const payload = {
      '/api/python/health': { status: 'ok' },
      '/api/python/knowledge/stats': { total_chunks: 9 },
      '/api/python/monitor': { agent_stats: { support: { total: 12 } }, active_alerts: [{ detail: '测试运行告警' }] },
      '/api/python/skills': { count: 1, skills: [{ name: 'refund-policy', description: '退款规则' }] },
      '/api/python/search': { results: [{ id: 'refund-1', title: '检索到的退款政策', content: '审核后原路退回。', score: 0.92 }] },
      '/api/python/knowledge/add': { added: 1 },
      '/api/python/chat': { response: '这是**离线回复**。', conversation_id: 'conversation-offline', request_id: 'request-offline', primary_agent: 'refund-agent', intent: 'refund', routing_reason: '根据退款问题选择退款能力', routing_confidence: 0.9, latency_ms: 138, knowledge_used: true },
      '/api/python/trace/tool/request-offline': { found: true, trace: { tools_used: ['knowledge_search'] } },
      '/api/python/eval/scenarios': { id: 'offline-catalog', version: 1, summary: { cases: 2, by_scenario: { basic_routing: 2 } } },
      '/api/python/eval/runs': { items: [] }
    }[target.pathname]
    if (!payload) unexpected.push(target.pathname)
    assert.ok(payload, `unexpected fake API request: ${target.pathname}`)
    return { ok: true, text: async () => JSON.stringify(payload) }
  }
  const view = renderer()
  let app
  t.after(() => {
    app?.unmount()
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
    assert.deepEqual(unexpected, [], 'all requests must stay within the fake API boundary')
  })
  app = view.createApp((await import(await componentModule(new URL('../src/App.vue', import.meta.url)))).default)
  app.mount(view.root)
  await settle()
  return { root: view.root, requests, storage }
}

test('connection and session settings remain available from each workspace', async t => {
  const { root, requests, storage } = await workspace(t)
  for (const view of ['对话', '知识库', '评测']) {
    await click(button(root, view))
    await click(button(root, '连接与会话配置'))
    const panel = configurationPanel(root)
    await enter(field(panel, '用户 ID'), `user-${view}`)
    await enter(field(panel, '会话 ID'), `conversation-${view}`)
    const before = requests.filter(item => item.path.endsWith('/health')).length
    await click(button(panel, '检查连接'))
    assert.equal(requests.filter(item => item.path.endsWith('/health')).length, before + 1)
    await click(button(panel, '刷新'))
    assert.equal(requests.filter(item => item.path.endsWith('/health')).length, before + 2)
    const settings = JSON.parse(storage.get('echomind.frontend.settings'))
    assert.equal(settings.userId, `user-${view}`)
    assert.equal(settings.conversationId, `conversation-${view}`)
    await click(button(root, '连接与会话配置'))
  }
  assert.equal(requests.some(item => item.path.endsWith('/chat')), false)
})

test('running details start collapsed and reveal the actual response route and runtime on demand', async t => {
  const { root, requests } = await workspace(t)
  button(root, '运行详情')
  assert.equal(visibleContents(root).includes('测试运行告警'), false)
  await enter(placeholder(root, '输入消息...'), '请解释退款规则')
  await submitFrom(placeholder(root, '输入消息...'))
  assert.equal(requests.filter(item => item.path.endsWith('/chat')).length, 1)
  assert.match(visibleContents(root), /这是离线回复。/)
  assert.equal(visibleContents(root).includes('根据退款问题选择退款能力'), false)
  await click(button(root, '运行详情'))
  assert.match(visibleContents(root), /根据退款问题选择退款能力/)
  assert.match(visibleContents(root), /138/)
  assert.match(visibleContents(root), /已使用/)
  assert.match(visibleContents(root), /测试运行告警/)
  const refreshBefore = requests.filter(item => item.path.endsWith('/monitor')).length
  await click(button(root, '刷新'))
  assert.equal(requests.filter(item => item.path.endsWith('/monitor')).length, refreshBefore + 1)
  await click(button(root, '运行详情'))
  assert.equal(visibleContents(root).includes('根据退款问题选择退款能力'), false)
  assert.match(visibleContents(root), /这是离线回复。/)
})

test('knowledge entry opens on demand, keeps drafts when folded, and submits through the existing API', async t => {
  const { root, requests } = await workspace(t)
  await click(button(root, '知识库'))
  assert.ok(!findField(root, '标题'), 'knowledge entry starts folded')
  await click(button(root, '添加知识'))
  await enter(field(root, '标题'), '离线录入标题')
  await enter(field(root, '内容'), '折叠后应保留的知识正文')
  const upload = field(root, '上传文件')
  assert.equal(upload.type, 'input')
  assert.equal(upload.props.type, 'file')
  assert.deepEqual(upload.props.accept.split(',').sort(), ['.json', '.md', '.txt'])
  await click(button(root, '添加知识'))
  assert.ok(!findField(root, '标题'), 'folded entry hides its title field')
  await click(button(root, '添加知识'))
  assert.equal(field(root, '标题').value, '离线录入标题')
  assert.equal(field(root, '内容').value, '折叠后应保留的知识正文')
  await click(button(root, '添加文档'))
  const additions = requests.filter(item => item.path.endsWith('/knowledge/add'))
  assert.equal(additions.length, 1)
  assert.deepEqual(JSON.parse(additions[0].options.body), {
    documents: [{ title: '离线录入标题', content: '折叠后应保留的知识正文' }]
  })
})

test('workspace navigation keeps the chat draft and retrieval results without sending a quick prompt', async t => {
  const { root, requests } = await workspace(t)
  await click(button(root, '退款申请'))
  assert.equal(placeholder(root, '输入消息...').value, '我想申请退款，订单号是 #12345')
  assert.equal(requests.some(item => item.path.endsWith('/chat')), false)
  await click(button(root, '知识库'))
  await enter(placeholder(root, '例如：退款多久到账'), '退款到账天数')
  await click(button(root, '搜索'))
  assert.match(visibleContents(root), /检索到的退款政策/)
  assert.match(visibleContents(root), /审核后原路退回。/)
  const searches = requests.filter(item => item.path.endsWith('/search'))
  assert.equal(searches.length, 1)
  assert.equal(searches[0].query.get('query'), '退款到账天数')
  await click(button(root, '评测'))
  assert.equal(field(root, '运行方式').value, 'validate')
  button(root, '校验场景数据')
  await click(button(root, '对话'))
  assert.equal(placeholder(root, '输入消息...').value, '我想申请退款，订单号是 #12345')
  await click(button(root, '知识库'))
  assert.equal(placeholder(root, '例如：退款多久到账').value, '退款到账天数')
  assert.match(visibleContents(root), /检索到的退款政策/)
  assert.equal(requests.filter(item => item.path.endsWith('/search')).length, 1)
  assert.equal(requests.some(item => item.path.endsWith('/chat') || item.path.endsWith('/scenarios/run')), false)
})

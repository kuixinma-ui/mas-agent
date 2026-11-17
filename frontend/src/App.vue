<template>
  <main :class="['app-shell', `app-shell-${activeView}`]">
    <aside class="app-sidebar">
      <a class="brand" href="#" aria-label="mas-agent 首页" @click.prevent="activeView = 'chat'">
        <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" /></svg></span>
        <span class="brand-name">mas-agent</span>
      </a>
      <span class="sidebar-label">工作区</span>
      <nav class="view-nav" aria-label="工作区">
        <button :class="{ active: activeView === 'chat' }" :aria-current="activeView === 'chat' ? 'page' : undefined" @click="activeView = 'chat'"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a9 9 0 0 1-9 9 9.5 9.5 0 0 1-4-.9L3 21l1.4-5a9 9 0 1 1 16.6-4.5Z" /></svg><span>对话</span></button>
        <button :class="{ active: activeView === 'knowledge' }" :aria-current="activeView === 'knowledge' ? 'page' : undefined" @click="activeView = 'knowledge'"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v16M3 3.5c4-1 6-.3 9 1.5 3-1.8 5-2.5 9-1.5V19c-4-1-6-.3-9 1.5C9 18.7 7 18 3 19Z" /></svg><span>知识库</span></button>
        <button :class="{ active: activeView === 'evaluation' }" :aria-current="activeView === 'evaluation' ? 'page' : undefined" @click="activeView = 'evaluation'"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v16h16M8 16v-4M12 16V8M16 16v-6M20 11V5" /></svg><span>评测</span></button>
      </nav>
      <div class="sidebar-footer"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M5 4h14v12H5ZM2 19h20" /></svg><span>本地工作区<small>{{ settings.userId || 'anonymous' }}</small></span></div>
    </aside>
    <div class="workspace-main">
    <header class="topbar">
      <div class="workspace-breadcrumb"><span>工作区</span><span aria-hidden="true">/</span><strong>{{ viewNames[activeView] }}</strong></div>
      <div class="topbar-tools">
        <span class="environment-pill" role="status">
          <i :class="healthOk ? 'online' : 'offline'"></i>
          <span class="backend-name">{{ currentBackend.label }}</span>{{ healthOk ? '连接正常' : healthLabel }}
        </span>
        <button class="icon-button" aria-label="连接与会话配置" :aria-expanded="showSettings" aria-controls="connection-settings" @click="showSettings = !showSettings"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 7h7m6 0h3M4 17h3m6 0h7" /><circle cx="14" cy="7" r="3" /><circle cx="10" cy="17" r="3" /></svg></button>
        <a class="docs-link" :href="docsUrl" target="_blank" rel="noreferrer">API 文档</a>
        <span class="user-avatar" :aria-label="`当前用户：${settings.userId || 'anonymous'}`">{{ userInitial }}</span>
      </div>
    </header>
    <section v-if="showSettings" id="connection-settings" class="connection-panel" aria-label="连接与会话配置">
      <div class="connection-panel-heading"><h2>连接与会话配置</h2><span class="status-copy" :class="healthOk ? 'success' : 'muted'">{{ healthLabel }}</span></div>
      <label><span>用户 ID</span><input v-model="settings.userId" @change="persist" placeholder="u1001" /></label>
      <label><span>会话 ID</span><input v-model="settings.conversationId" @change="persist" placeholder="自动生成" /></label>
      <div class="side-actions"><button @click="checkHealth">检查连接</button><button class="quiet-button" @click="refreshConsole">刷新</button></div>
      <p v-if="!healthOk && statusText" class="connection-error">{{ statusText }}</p>
    </section>
    <div v-if="toast" class="toast" role="status">{{ toast }}</div>

    <section v-if="activeView === 'chat'" class="page page-chat">
      <div class="page-heading">
        <div class="heading-copy">
          <h1>对话</h1>
          <p>与客服 Agent 对话，查看每次响应的依据。</p>
        </div>
        <div class="heading-actions">
          <button class="quiet-button" @click="clearConversation">清空会话</button>
          <button class="quiet-button" :aria-expanded="showInspector" aria-controls="chat-inspector" @click="showInspector = !showInspector">运行详情</button>
        </div>
      </div>

      <div class="chat-layout" :class="{ 'with-details': showInspector }">
        <section class="chat-stage">
          <div class="stage-bar">
            <div class="stage-context">
              <span class="context-dot"></span>
              <span>{{ currentBackend.baseUrl }}</span>
            </div>
            <span>{{ messages.length }} 条消息</span>
          </div>

          <div class="messages" ref="messageList">
            <article v-for="item in messages" :key="item.id" :class="['message', item.role]">
              <div class="message-meta">
                <span>{{ item.role === 'user' ? '你' : currentBackend.label + ' Agent' }}</span>
                <small v-if="item.meta">{{ item.meta }}</small>
              </div>
              <p><template
                v-for="(part, index) in (item.role === 'assistant' ? String(item.content ?? '').split(/(\*\*[^*\n]+\*\*)/g) : [item.content])"
                :key="index"
              ><strong v-if="index % 2 === 1">{{ part.slice(2, -2) }}</strong><template v-else>{{ part }}</template></template></p>
            </article>

            <div v-if="messages.length === 0" class="empty-state">
              <div class="empty-symbol" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" /></svg></div>
              <h2>有什么可以帮你？</h2>
              <p>从一个客服问题开始。</p>
              <div class="starter-prompts">
                <button @click="usePrompt('我想申请退款，订单号是 #12345')">退款申请</button>
                <button @click="usePrompt('登录时提示错误，应该怎么排查？')">技术排查</button>
                <button @click="usePrompt('发票多久可以开具？')">发票咨询</button>
              </div>
            </div>
          </div>

          <form class="composer" @submit.prevent="sendMessage">
            <textarea
              aria-label="输入消息"
              v-model="draft"
              rows="2"
              placeholder="输入消息..."
              @keydown.meta.enter.prevent="sendMessage"
              @keydown.ctrl.enter.prevent="sendMessage"
            ></textarea>
            <div class="composer-bottom">
              <span>⌘ / Ctrl + Enter 发送</span>
              <button type="submit" :disabled="busy || !draft.trim()">{{ busy ? '处理中' : '发送' }}</button>
            </div>
          </form>
        </section>

        <aside v-if="showInspector" id="chat-inspector" class="chat-sidebar" aria-label="运行详情">
          <div class="chat-sidebar-scroll">
            <section class="side-card session-card">
              <div class="card-heading">
                <div>
                  <h2>会话信息</h2>
                </div>
                <span class="status-copy muted">{{ settings.conversationId ? '已启用' : '新会话' }}</span>
              </div>
              <div class="session-grid">
                <div>
                  <span>会话 ID</span>
                  <strong>{{ settings.conversationId || '自动生成' }}</strong>
                </div>
                <div>
                  <span>用户 ID</span>
                  <strong>{{ settings.userId || 'anonymous' }}</strong>
                </div>
              </div>
            </section>

            <section class="side-card trace-card">
              <div class="card-heading">
                <div>
                  <h2>最近一次请求</h2>
                </div>
                <span class="trace-status" :class="lastResponse ? 'has-data' : ''"></span>
              </div>

              <div v-if="lastResponse" class="trace-body">
                <div class="latency">
                  <span>响应耗时</span>
                  <strong>{{ lastResponse.latencyMs || '-' }}<small> ms</small></strong>
                </div>
                <dl class="detail-list">
                  <div><dt>主 Agent</dt><dd>{{ lastResponse.primaryAgent || lastResponse.agentType || '-' }}</dd></div>
                  <div><dt>意图</dt><dd>{{ lastResponse.intent || '-' }}</dd></div>
                  <div><dt>置信度</dt><dd>{{ formatPercent(lastResponse.routingConfidence) }}</dd></div>
                  <div><dt>知识库</dt><dd :class="lastResponse.knowledgeUsed ? 'success' : 'muted'">{{ lastResponse.knowledgeUsed ? '已使用' : '未使用' }}</dd></div>
                  <div><dt>转人工</dt><dd :class="lastResponse.escalated ? 'danger' : 'muted'">{{ lastResponse.escalated ? '是' : '否' }}</dd></div>
                </dl>
                <p v-if="lastResponse.routingReason" class="routing-reason">{{ lastResponse.routingReason }}</p>
              </div>
              <p v-else class="side-empty">发送消息后，这里会显示 Agent 路由、意图和耗时。</p>
            </section>

            <section class="side-card monitor-card">
              <div class="card-heading">
                <div>
                  <h2>运行状态</h2>
                </div>
                <button class="link-button" @click="loadMonitor">刷新</button>
              </div>
              <div class="mini-stats">
                <div><strong>{{ totalRequests }}</strong><span>请求</span></div>
                <div><strong>{{ agentCount }}</strong><span>Agent</span></div>
                <div><strong>{{ activeAlerts.length }}</strong><span>告警</span></div>
              </div>
              <div v-if="activeAlerts.length" class="alert-note">{{ activeAlerts[0].detail || activeAlerts[0].title }}</div>
              <p v-else class="healthy-note">当前没有活跃告警。</p>
            </section>
          </div>
        </aside>
      </div>
    </section>

    <section v-else-if="activeView === 'knowledge'" class="page page-knowledge">
      <div class="page-heading">
        <div class="heading-copy">
          <h1>知识库</h1>
          <p>搜索、补充和维护客服 Agent 使用的知识片段。</p>
        </div>
        <div class="knowledge-heading-actions"><div class="count-display"><strong>{{ knowledgeCount }}</strong><span>个知识片段</span></div><button :aria-expanded="showKnowledgeImport" aria-controls="knowledge-import" @click="showKnowledgeImport = !showKnowledgeImport">添加知识</button></div>
      </div>

      <div class="knowledge-layout">
        <section v-if="showKnowledgeImport" id="knowledge-import" class="workspace-card import-workspace" aria-label="添加知识">
          <div class="card-heading"><h2>添加知识</h2></div>
          <div class="import-form">
            <div class="import-fields"><label><span>标题</span><input v-model="docTitle" placeholder="退款补充政策" /></label><label><span>内容</span><textarea v-model="docContent" rows="5" placeholder="输入客服规范、产品说明或排障流程"></textarea></label><button @click="submitKnowledge" :disabled="busy || !docTitle.trim() || !docContent.trim()">{{ busy ? '处理中…' : '添加文档' }}</button></div>
            <div class="file-import"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H5v20h14V7l-5-5Zm0 0v6h5M12 18v-7m-3 3 3-3 3 3" /></svg><strong>从文件导入</strong><p>支持 .txt、.md、.json</p><label class="upload-button">上传文件<input type="file" accept=".txt,.md,.json" :disabled="busy" @change="handleUpload" /></label></div>
          </div>
        </section>
        <section class="workspace-card search-workspace" aria-label="检索知识">
          <div class="search-line">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="7" /><path d="m16 16 5 5" /></svg><input v-model="searchQuery" aria-label="检索知识" placeholder="例如：退款多久到账" @keydown.enter="searchKnowledge" />
            <button class="secondary" @click="searchKnowledge" :disabled="busy || !searchQuery.trim()">{{ busy ? '处理中…' : '搜索' }}</button>
          </div>
          <div class="card-heading"><h2>检索结果</h2><span v-if="searchResults.length" class="status-copy muted">{{ searchResults.length }} 条结果</span></div>
          <div v-if="searchResults.length" class="result-list">
            <article v-for="(item, index) in searchResults" :key="item.id || item.title || index" class="result-item">
              <span class="result-number">{{ String(index + 1).padStart(2, '0') }}</span>
              <div>
                <div class="result-title"><strong>{{ item.title || '未命名文档' }}</strong><small>相关度 {{ item.score ?? '-' }}</small></div>
                <p>{{ item.content }}</p>
              </div>
            </article>
          </div>
          <div v-else class="workspace-empty">输入客户问题开始搜索。</div>
        </section>

      </div>

      <details class="workspace-card skills-workspace">
        <summary><span>已加载 Skills <small>{{ skillsData.skills.length }} 项能力</small></span><svg class="disclosure-chevron" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg></summary>
        <div class="skills-body">
        <div class="card-heading">
          <span>能力说明与内容长度</span>
          <button class="link-button" :disabled="busy" @click="reloadSkillSet">重新加载</button>
        </div>
        <div class="skill-table">
          <div v-for="skill in skillsData.skills" :key="skill.name" class="skill-item">
            <span class="skill-dot"></span><strong>{{ skill.name }}</strong><span>{{ skill.description || '业务规范能力' }}</span><small>{{ skill.content_chars || 0 }} 字符</small>
          </div>
          <div v-if="!skillsData.skills.length" class="workspace-empty">暂无已加载 Skill。</div>
        </div>
        </div>
      </details>
    </section>

    <EvaluationLab v-else :base-url="currentBackend.baseUrl" />
    </div>
  </main>
</template>

<script setup>
import EvaluationLab from './components/EvaluationLab.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  addKnowledge,
  backendMeta,
  createInitialSettings,
  reloadSkills,
  requestChat,
  requestHealth,
  requestKnowledgeStats,
  requestMonitor,
  requestSearch,
  requestToolTrace,
  requestSkills,
  saveSettings,
  uploadKnowledge
} from './lib/backends'

const settings = reactive(createInitialSettings())
const activeView = ref('chat')
const viewNames = { chat: '对话', knowledge: '知识库', evaluation: '评测' }
const showSettings = ref(false)
const showInspector = ref(false)
const showKnowledgeImport = ref(false)
const messages = ref([])
const draft = ref('')
const busy = ref(false)
const healthOk = ref(false)
const healthLabel = ref('未检查')
const statusText = ref('')
const knowledgeCount = ref('-')
const searchQuery = ref('退款多久能到账')
const searchResults = ref([])
const docTitle = ref('退款补充政策')
const docContent = ref('大促期间退款审核时间可能延长到 3-5 个工作日。')
const messageList = ref(null)
const monitorData = ref({ agent_stats: {}, tool_stats: {}, active_alerts: [], suggestions: [] })
const skillsData = ref({ count: 0, skills: [], errors: [] })
const lastResponse = ref(null)
const lastTrace = ref(null)
const toast = ref('')
let toastTimer
let messageSequence = 0

const currentBackend = computed(() => backendMeta(settings.backend, settings))
const docsUrl = computed(() => `${currentBackend.value.baseUrl}/docs`)
const userInitial = computed(() => (settings.userId || 'U').slice(0, 1).toUpperCase())
const activeAlerts = computed(() => monitorData.value.active_alerts || [])
const agentCount = computed(() => Object.keys(monitorData.value.agent_stats || {}).length)
const totalRequests = computed(() => Object.values(monitorData.value.agent_stats || {}).reduce((sum, item) => sum + Number(item.total || 0), 0))

watch(() => settings.conversationId, persist)
onMounted(() => {
  refreshConsole()
})

onBeforeUnmount(() => {
  clearTimeout(toastTimer)
})

function persist() { saveSettings(settings) }

async function refreshConsole() {
  await Promise.allSettled([checkHealth(), loadStats(), loadMonitor(), loadSkills()])
}

async function checkHealth() {
  try {
    const data = await requestHealth(settings.backend, settings)
    healthOk.value = data.status === 'ok'
    healthLabel.value = data.status || 'ok'
    statusText.value = JSON.stringify(data, null, 2)
  } catch (error) {
    healthOk.value = false
    healthLabel.value = '不可用'
    statusText.value = error.message

  }
}

async function loadStats() {
  try {
    const data = await requestKnowledgeStats(settings.backend, settings)
    knowledgeCount.value = data.total_chunks ?? data.totalChunks ?? '-'
  } catch {
    knowledgeCount.value = '-'
  }
}

async function loadMonitor() {
  try {
    monitorData.value = await requestMonitor(settings.backend, settings)
  } catch {
    monitorData.value = { agent_stats: {}, tool_stats: {}, active_alerts: [], suggestions: [] }
  }
}

async function loadSkills() {
  try {
    skillsData.value = await requestSkills(settings.backend, settings)
  } catch {
    skillsData.value = { count: 0, skills: [], errors: [] }
  }
}

async function reloadSkillSet() {
  busy.value = true
  try {
    skillsData.value = await reloadSkills(settings.backend, settings)
    showToast('Skills 已重新加载')
  } catch (error) {
    statusText.value = error.message
    showToast('Skills 加载失败')
  } finally { busy.value = false }
}

async function sendMessage() {
  const content = draft.value.trim()
  if (!content || busy.value) return
  messages.value.push({ id: createMessageId(), role: 'user', content })
  draft.value = ''
  busy.value = true
  try {
    const response = await requestChat(settings.backend, settings, content)
    if (response.conversationId && !settings.conversationId) {
      settings.conversationId = response.conversationId
      persist()
    }
    lastResponse.value = response
    lastTrace.value = await loadToolTrace(response.requestId)
    const meta = [response.intent, response.primaryAgent || response.agentType, response.knowledgeUsed ? 'RAG' : '', response.escalated ? '转人工' : ''].filter(Boolean).join(' · ')
    messages.value.push({ id: createMessageId(), role: 'assistant', content: response.response, meta, trace: lastTrace.value?.trace || null })
    await loadMonitor()
  } catch (error) {
    messages.value.push({ id: createMessageId(), role: 'assistant', content: error.message, meta: '请求失败' })
  } finally {
    busy.value = false
    await nextTick()
    messageList.value?.scrollTo({ top: messageList.value.scrollHeight, behavior: 'smooth' })
  }
}

function usePrompt(prompt) { draft.value = prompt }

function clearConversation() {
  messages.value = []
  lastResponse.value = null
  lastTrace.value = null
  settings.conversationId = ''
  persist()
}

async function searchKnowledge() {
  busy.value = true
  try {
    const data = await requestSearch(settings.backend, settings, searchQuery.value, 5)
    searchResults.value = data.results || []
    showToast(`检索完成，返回 ${searchResults.value.length} 条结果`)
  } catch (error) {
    statusText.value = error.message
    showToast('检索失败，请检查连接')
  } finally { busy.value = false }
}

async function submitKnowledge() {
  busy.value = true
  try {
    const data = await addKnowledge(settings.backend, settings, [{ title: docTitle.value.trim(), content: docContent.value.trim() }])
    statusText.value = JSON.stringify(data, null, 2)
    await loadStats()
    showToast('文档已添加')
  } catch (error) {
    statusText.value = error.message
    showToast('文档导入失败')
  } finally { busy.value = false }
}

async function handleUpload(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  busy.value = true
  try {
    const data = await uploadKnowledge(settings.backend, settings, file)
    statusText.value = JSON.stringify(data, null, 2)
    await loadStats()
    showToast(`${file.name} 导入成功`)
  } catch (error) {
    statusText.value = error.message
    showToast('文件导入失败')
  } finally { busy.value = false }
}


async function loadToolTrace(requestId) {
  try {
    return await requestToolTrace(settings.backend, settings, requestId)
  } catch {
    return null
  }
}

function formatPercent(value) {
  const number = Number(value || 0)
  return `${(number <= 1 ? number * 100 : number).toFixed(1)}%`
}

function formatJson(value) {
  try {
    return JSON.stringify(value ?? {}, null, 2)
  } catch {
    return String(value ?? '')
  }
}

function createMessageId() {
  messageSequence += 1
  return `message-${Date.now()}-${messageSequence}`
}

function showToast(message) {
  toast.value = message
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = '' }, 2600)
}
</script>

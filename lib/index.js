/**
 * dsh-input-prediction —— 宿主半区（Host half）
 *
 * 目标：给「输入预测」提供大脑。客户端（输入框里的灰字 / 建议气泡）只负责
 * 收集「当前草稿 + 光标」和呈现，把请求 POST 到本半区的路由；本半区负责：
 *   ① 读出该会话最近的对话（sessionQuery.readSurface，退回 readSession）
 *   ② 拼一段「以这位用户的口吻续写」的提示词，调 ctx.llm.stream 流式生成
 *   ③ 用 NDJSON 把增量文本推回页面，页面边收边画灰字
 *   ④ 每轮回复结束后再生成 1–3 条「你可能要发的下一条」（建议气泡）
 *
 * 路由（都在 /dsh-input-prediction 下，全部走同一道信任栅栏）：
 *   POST /dsh-input-prediction/predict   → NDJSON 流：{type:'delta'|'done'|'error'}
 *   POST /dsh-input-prediction/suggest   → JSON：{ok, items:[{text}]}（建议气泡）
 *   GET  /dsh-input-prediction/settings  → JSON：当前生效的开关与数量
 *   POST /dsh-input-prediction/settings  → 设置面板写回来的偏好（落盘 + 立即生效）
 *   GET  /dsh-input-prediction/hello     → 只读自检：配置 + 服务可用性
 *   GET  /dsh-input-prediction/transcript?sessionId=… → 只读自检：本半区看到的对话
 *
 * 安全：本路由能花掉用户的 token，且能读到会话内容，所以要求
 * 同源、非 cross-site、Host 为回环（或显式信任），并委托宿主信任栅栏
 * ctx.connection.requestRejection（可用时；它抛异常按拒绝处理）。
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const ROUTE_BASE = '/dsh-input-prediction'
const PREDICT_ROUTE = `${ROUTE_BASE}/predict`
const HELLO_ROUTE = `${ROUTE_BASE}/hello`
const TRANSCRIPT_ROUTE = `${ROUTE_BASE}/transcript`
/** 每轮回复后取 1–3 条「你可能要发的下一条」候选（点击即可发送）。 */
const SUGGEST_ROUTE = `${ROUTE_BASE}/suggest`
/** 设置面板读写用户偏好（GET 读 / POST 写）。 */
const SETTINGS_ROUTE = `${ROUTE_BASE}/settings`
/** 客户端半区回报自身状态（加载成功 / 接受补全 / 出错）的自检通道。 */
const TELEMETRY_ROUTE = `${ROUTE_BASE}/telemetry`

const REQUEST_TIMEOUT_MS = 20_000
const LOG_MAX_BYTES = 1024 * 1024

const DEFAULTS = {
  /** 总开关：false 时客户端拿到 hello 后不工作（路由仍在，便于自检）。 */
  enabled: true,
  /** 灰字补全（打字停顿后预测「接着要打的字」，Tab 接受）。 */
  completionEnabled: true,
  /** 建议气泡：助手每回复完一轮，在输入框上方给出「你可能要发的下一条」，点一下就发送。 */
  chipsEnabled: true,
  /** 建议气泡的数量（1–3）。 */
  chipCount: 3,
  /** 建议气泡单条的长度上限——它是按钮，太长会撑坏一行。 */
  chipMaxChars: 40,
  /**
   * 诊断日志文件路径。'' = 关闭。开启后本半区会把「客户端是否加载、
   * 每次预测的草稿与结果、Tab 接受、被拒绝的请求」逐行写成 JSON，
   * 便于在没有浏览器控制台的情况下排查。
   */
  debugLog: '',
  /**
   * 设置面板写下来的覆盖值存哪。'' = 默认（$DSH_HOME/input-prediction.settings.json）。
   * 设置面板改的是「用户偏好」，不该去改 cordis.patch.yml，所以单独落一个文件。
   */
  settingsFile: '',
  /** '' = 跟随 agent-default-model 的当前选择。 */
  provider: '',
  model: '',
  /**
   * 推理强度：'off' | 'low' | 'high' | 'max'，'' = 用 provider 默认。
   * 默认 off —— 输入框补全是「续写十几个字」，让模型先想一遍只会白烧 token：
   * provider 默认 effort 是 high，maxTokens 会被思考过程吃光，返回空文本。
   */
  reasoningEffort: 'off',
  maxTokens: 160,
  temperature: 0.3,
  /** 送给模型的对话条数 / 每条最多多少字。 */
  contextMessages: 16,
  contextChars: 600,
  /** 预测文本本身的长度上限（超出截断）。 */
  maxSuggestionChars: 60,
  /** 额外的风格提示，追加在系统提示词后面。 */
  styleHint: '',
  /** 遇到换行就停：预测永远是「一行以内的补充」。 */
  stopAtNewline: true,
  /** 建议气泡那一次生成的最大 token（要装下 chipCount 行，比补全宽裕）。 */
  chipsMaxTokens: 320,
  chipsTemperature: 0.7,
}

/** provider 只接受这几个值（''= 不传，跟随 provider 默认）。 */
const REASONING_EFFORTS = ['', 'off', 'low', 'high', 'max']

const SYSTEM_PROMPT = [
  '你是一台「输入框预测器」，嵌在一个 AI 编程助手的聊天输入框后面。',
  '屏幕上有一位用户正在和助手对话。你的唯一任务：预测这位用户接下来最可能输入的文字，',
  '让他在输入框里按一次 Tab 就能把这段文字补上。',
  '',
  '铁律：',
  '1. 你扮演的是「这位用户本人」，不是助手。你写的每一句都必须是他会打出来的话，',
  '   而不是对问题作出的回答。',
  '2. 只输出「接下来要补上的文字」本身。不要重复他已经打出的部分，',
  '   不要引号、不要解释、不要编号、不要 Markdown、不要任何前后缀。',
  '3. 你输出的文字会被原样接在他已打出的内容后面，所以必须能无缝拼成一句通顺的话。',
  '4. 语言、用词、语气、标点、中英混用习惯都要贴近这位用户本人——',
  '   观察历史里他说话的方式（长短、是否用标点、是否客气、是否直接下令），照着他的样子写。',
  '5. 宁可短，不可长。一句话以内，最多二十来个字。',
  '6. 没把握就少写；完全猜不出来（或者没什么可说的）就输出空字符串——',
  '   空白比一句驴唇不对马嘴的猜测好得多。',
].join('\n')

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function normalizeConfig(raw) {
  const cfg = { ...DEFAULTS }
  if (raw === null || typeof raw !== 'object') return cfg
  for (const key of Object.keys(DEFAULTS)) {
    if (raw[key] === undefined || raw[key] === null) continue
    cfg[key] = raw[key]
  }
  cfg.maxTokens = clampInt(cfg.maxTokens, 8, 512, DEFAULTS.maxTokens)
  cfg.contextMessages = clampInt(cfg.contextMessages, 0, 60, DEFAULTS.contextMessages)
  cfg.contextChars = clampInt(cfg.contextChars, 80, 4000, DEFAULTS.contextChars)
  cfg.maxSuggestionChars = clampInt(cfg.maxSuggestionChars, 8, 400, DEFAULTS.maxSuggestionChars)
  cfg.chipCount = clampInt(cfg.chipCount, 1, 3, DEFAULTS.chipCount)
  cfg.chipMaxChars = clampInt(cfg.chipMaxChars, 8, 120, DEFAULTS.chipMaxChars)
  cfg.chipsMaxTokens = clampInt(cfg.chipsMaxTokens, 64, 1024, DEFAULTS.chipsMaxTokens)
  const chipTemp = Number(cfg.chipsTemperature)
  cfg.chipsTemperature = Number.isFinite(chipTemp) ? Math.min(1.5, Math.max(0, chipTemp)) : DEFAULTS.chipsTemperature
  const temp = Number(cfg.temperature)
  cfg.temperature = Number.isFinite(temp) ? Math.min(1.5, Math.max(0, temp)) : DEFAULTS.temperature
  cfg.provider = typeof cfg.provider === 'string' ? cfg.provider.trim() : ''
  cfg.model = typeof cfg.model === 'string' ? cfg.model.trim() : ''
  cfg.reasoningEffort = REASONING_EFFORTS.includes(cfg.reasoningEffort) ? cfg.reasoningEffort : DEFAULTS.reasoningEffort
  cfg.styleHint = typeof cfg.styleHint === 'string' ? cfg.styleHint.trim() : ''
  cfg.debugLog = typeof cfg.debugLog === 'string' ? cfg.debugLog.trim() : ''
  cfg.settingsFile = typeof cfg.settingsFile === 'string' ? cfg.settingsFile.trim() : ''
  cfg.enabled = cfg.enabled !== false
  cfg.completionEnabled = cfg.completionEnabled !== false
  cfg.chipsEnabled = cfg.chipsEnabled !== false
  cfg.stopAtNewline = cfg.stopAtNewline !== false
  return cfg
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * 诊断日志：把事件逐行追加成 JSON。任何写入失败都吞掉——
 * 诊断通道永远不能影响预测本身。
 * @param {object} cfg - 归一化后的配置。
 * @returns {(event: string, data?: object) => void} 记录函数（debugLog 为空时是空操作）。
 */
function makeLogger(cfg) {
  const path = cfg.debugLog
  if (path === '') return () => {}
  let writes = 0
  return (event, data = {}) => {
    try {
      writes += 1
      if (writes % 200 === 0 && statSync(path).size > LOG_MAX_BYTES) writeFileSync(path, '')
      appendFileSync(path, `${JSON.stringify({ t: new Date().toISOString(), event, ...data })}\n`)
    } catch {
      /* 诊断失败不影响功能 */
    }
  }
}


/** 只认回环：localhost / *.localhost / 127.0.0.0/8（逐段校验）/ ::1。 */
function isLoopbackHostname(hostname) {
  const h = String(hostname || '')
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
  if (h === '') return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  if (Number(m[1]) !== 127) return false
  return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
}

function hostnameOf(hostHeader) {
  const raw = String(hostHeader || '')
    .trim()
    .toLowerCase()
  if (raw === '') return ''
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    return end === -1 ? raw.slice(1) : raw.slice(1, end)
  }
  const colon = raw.lastIndexOf(':')
  return colon === -1 ? raw : raw.slice(0, colon)
}

/** 读请求体（JSON），带体积上限。 */
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, code, payload) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/**
 * 把一个 LLM 失败对象压成一行可读文本。cause 往往才是真正的异常
 * （例如 Messages 传输把 TypeError 包成 "transport failed"），必须一起带上。
 */
/**
 * 「模型什么都没说」这一类失败：对补全任务而言等于「没有建议」，
 * 应当当作空结果处理，而不是当成错误。
 */
function isNoContentFailure(failure) {
  if (failure === null || typeof failure !== 'object') return false
  const code = typeof failure.code === 'string' ? failure.code : ''
  const message = typeof failure.message === 'string' ? failure.message : ''
  return code === 'EMPTY_RESPONSE' || message.includes('EMPTY_RESPONSE') || message.includes('returned no content')
}

function describeFailure(failure) {
  if (failure === null || failure === undefined) return 'unknown'
  if (typeof failure === 'string') return failure
  const parts = []
  if (typeof failure.code === 'string' && failure.code !== '') parts.push(`[${failure.code}]`)
  if (typeof failure.message === 'string' && failure.message !== '') parts.push(failure.message)
  if (typeof failure.status === 'number') parts.push(`status=${failure.status}`)
  const cause = failure.cause
  if (cause !== null && cause !== undefined) {
    parts.push(`cause=${(cause && cause.message) || String(cause)}`)
  }
  if (parts.length === 0) {
    try {
      parts.push(JSON.stringify(failure).slice(0, 400))
    } catch {
      parts.push(String(failure))
    }
  }
  return parts.join(' ')
}

/** 从 content（字符串或块数组）里抽出纯文本。 */
function blocksToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (typeof block === 'string') {
      out += block
      continue
    }
    if (block === null || typeof block !== 'object') continue
    if (typeof block.text === 'string') out += block.text
  }
  return out
}

/**
 * 会话事件 → 消息对象。
 * - user/message      ：data 就是消息本体
 * - assistant/message ：data 是 { turn, step, message, stream, usage }
 */
function messageOf(event) {
  const data = event && event.data
  if (data === null || typeof data !== 'object') return null
  if (typeof data.role === 'string') return data
  if (data.message !== null && typeof data.message === 'object' && typeof data.message.role === 'string') {
    return data.message
  }
  return null
}

function clip(text, limit) {
  const s = String(text || '')
  if (s.length <= limit) return s
  const head = Math.ceil(limit * 0.6)
  const tail = limit - head
  return `${s.slice(0, head)}……${s.slice(s.length - tail)}`
}

/* ------------------------------------------------------------------ */
/* 对话读取                                                            */
/* ------------------------------------------------------------------ */

/**
 * 读出该会话最近的对话（从旧到新）。
 * 首选 readSurface：它是**当前模型看到的表面**——压缩/替换之后仍然成立，
 * 而且比原始日志小得多；读不到再退回 readSession（原始事件日志）。
 */
async function readConversation(ctx, sessionId, cfg) {
  const sq = ctx.get('sessionQuery')
  if (sq === undefined || sq === null || typeof sessionId !== 'string' || sessionId === '') {
    return { entries: [], source: 'none', events: 0 }
  }
  let events = null
  let source = 'surface'
  if (typeof sq.readSurface === 'function') {
    try {
      const snap = await sq.readSurface(sessionId)
      if (snap !== null && snap !== undefined && Array.isArray(snap.events)) events = snap.events
    } catch {
      events = null
    }
  }
  if (events === null && typeof sq.readSession === 'function') {
    source = 'log'
    try {
      const snap = await sq.readSession(sessionId)
      if (snap !== null && snap !== undefined && Array.isArray(snap.events)) events = snap.events
    } catch {
      events = null
    }
  }
  if (events === null) return { entries: [], source: 'error', events: 0 }

  const entries = []
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const message = messageOf(event)
    if (message === null) continue
    const text = blocksToText(message.content).trim()
    if (text === '') continue
    entries.push({ role: message.role === 'user' ? 'user' : 'assistant', text })
  }
  const kept = cfg.contextMessages > 0 ? entries.slice(-cfg.contextMessages) : []
  return { entries: kept, source, events: events.length, total: entries.length }
}

/* ------------------------------------------------------------------ */
/* 提示词                                                              */
/* ------------------------------------------------------------------ */

/**
 * 把这位用户自己说过的话单独摘出来，作为「口吻样本」。
 * 这是需求的另一半：预测要像他本人，而不是像通用助手。
 */
function styleSample(entries, cfg) {
  const mine = entries.filter((e) => e.role === 'user').slice(-6)
  if (mine.length === 0) return ''
  return mine.map((e) => `- ${clip(e.text, 120)}`).join('\n')
}

function buildPrompt(entries, draft, cfg) {
  const lines = []
  for (const entry of entries) {
    lines.push(`${entry.role === 'user' ? '用户' : '助手'}：${clip(entry.text, cfg.contextChars)}`)
  }
  const history = lines.length > 0 ? lines.join('\n\n') : '（这是本次对话的开头，还没有任何往来消息）'

  const style = styleSample(entries, cfg)
  const styleBlock = style === ''
    ? []
    : ['', '【这位用户平时说话的样子（照着他的口吻写，别换成书面语）】', style]

  if (draft === '') {
    return [
      '【最近的对话】',
      history,
      ...styleBlock,
      '',
      '【现在】输入框是空的，用户还没开始打字。',
      '请以用户本人的口吻，写出他接下来最可能发送的那条消息——通常很短：',
      '一句追问、一句确认、一句吐槽，或者一条新指令。只输出这条消息本身。',
    ].join('\n')
  }

  // 让草稿落在最后一行：这就是一次「续写」，而不是「重新生成一整句」。
  return [
    '【最近的对话】',
    history,
    ...styleBlock,
    '',
    '【现在】用户正在输入框里打字，光标停在末尾。',
    '请以用户本人的口吻，把他这句话接着写完。只输出紧接着的后续文字，',
    '不要重复他已经打出的部分，不要解释：',
    '',
    `用户：${draft}`,
  ].join('\n')
}

/** 清理模型输出：第一行、去引号、去重复尾巴、限长。 */
function sanitizeSuggestion(raw, draft, cfg) {
  let s = String(raw || '').replace(/\r/g, '')
  const newline = s.indexOf('\n')
  if (newline !== -1) s = s.slice(0, newline)
  s = s.replace(/^\s+/, '').replace(/^["'“”‘’「『]+/, '')
  s = s.replace(/["'“”‘’」』]+$/, '')
  if (draft !== '' && s !== '') {
    const max = Math.min(draft.length, s.length, 16)
    for (let n = max; n >= 2; n -= 1) {
      if (s.startsWith(draft.slice(draft.length - n))) {
        s = s.slice(n)
        break
      }
    }
  }
  s = s.replace(/\s+$/, '')
  if (s.length > cfg.maxSuggestionChars) s = s.slice(0, cfg.maxSuggestionChars)
  return s.replace(/^\s+/, '')
}

/* ------------------------------------------------------------------ */
/* 用户偏好（设置面板）                                                 */
/* ------------------------------------------------------------------ */

/**
 * 设置面板能改的东西。这份清单同时是：
 *   ① 面板 UI 的数据源（客户端拿它渲染，不必硬编码）
 *   ② 持久化白名单（POST /settings 只接受这里的 key）
 * 注意与 cordis.patch.yml 的分工：patch 是「部署默认值」，这里写的是用户
 * 在面板上点出来的偏好，落在用户目录下的小 JSON 里，优先级高于 patch。
 */
const SETTINGS_ITEMS = [
  {
    key: 'completionEnabled',
    kind: 'boolean',
    label: '灰字补全',
    hint: '打字停顿时在光标后显示灰色预测，按 Tab 接受',
    default: DEFAULTS.completionEnabled,
  },
  {
    key: 'chipsEnabled',
    kind: 'boolean',
    label: '回复后推荐',
    hint: '每轮回答结束后，在输入框上方给出几条可直接发送的消息',
    default: DEFAULTS.chipsEnabled,
  },
  {
    key: 'chipCount',
    kind: 'number',
    label: '推荐条数',
    hint: '每轮生成几条候选（1–3）',
    min: 1,
    max: 3,
    step: 1,
    default: DEFAULTS.chipCount,
  },
]

/** 设置文件路径：patch 里给了就用它，否则 $DSH_HOME/input-prediction.settings.json。 */
function resolveSettingsPath(cfg) {
  if (typeof cfg.settingsFile === 'string' && cfg.settingsFile !== '') return cfg.settingsFile
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'input-prediction.settings.json')
}

/** 读设置文件；不存在/坏了都当「没有偏好」，绝不因此让插件起不来。 */
function readSettingsFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 先写临时文件再 rename：避免面板连点写坏 JSON（读到半个文件就全丢了）。 */
function writeSettingsFile(path, value) {
  const tmp = `${path}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

/** 生效设置 = patch 默认值 覆盖以 文件里的用户偏好。 */
function pickSettings(cfg, stored) {
  const out = {
    completionEnabled: cfg.completionEnabled !== false,
    chipsEnabled: cfg.chipsEnabled !== false,
    chipCount: clampInt(cfg.chipCount, 1, 3, DEFAULTS.chipCount),
  }
  if (stored === null || typeof stored !== 'object') return out
  for (const item of SETTINGS_ITEMS) {
    const value = stored[item.key]
    if (value === undefined || value === null) continue
    if (item.kind === 'boolean') {
      if (typeof value === 'boolean') out[item.key] = value
    } else if (item.kind === 'number') {
      out[item.key] = clampInt(value, item.min, item.max, out[item.key])
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 建议气泡（每轮回复后的 1–3 条候选）                                   */
/* ------------------------------------------------------------------ */

const CHIPS_SYSTEM_PROMPT = [
  '你在替一位用户起草他接下来可能发送的消息，供他点一下就能发出。',
  '要求：',
  '1. 以用户本人的口吻写，读起来像他随手打的，不是助手在解释。',
  '2. 贴着刚才那轮对话的具体内容写（提到同一个文件、命令、报错、结论），不要写放之四海皆准的空话。',
  '3. 每条都短，一句话以内，别用书面语，不要编号、不要引号、不要解释。',
  '4. 几条之间要给不同的走向（追问细节 / 让他继续动手 / 纠偏 / 收尾），不要只是换词。',
  '5. 一行一条，只输出这些行本身。',
].join('\n')

function buildChipsPrompt(entries, cfg, count) {
  const lines = []
  for (const entry of entries) {
    lines.push(`${entry.role === 'user' ? '用户' : '助手'}：${clip(entry.text, cfg.contextChars)}`)
  }
  const history = lines.length > 0 ? lines.join('\n\n') : '（这是本次对话的开头，还没有任何往来消息）'
  const style = styleSample(entries, cfg)
  const styleBlock = style === '' ? [] : ['', '【这位用户平时说话的样子】', style]
  return [
    '【最近的对话】',
    history,
    ...styleBlock,
    '',
    '【现在】助手刚刚回复完，轮到用户说话了。',
    `请写出他现在最可能发送的 ${count} 条消息，一行一条（顺序按可能性从高到低）。`,
    `每条不超过 ${cfg.chipMaxChars} 个字，宁可短一点也别超。`,
  ].join('\n')
}

/** 超长候选按标点断，别把词切成两半（"…conversation.inp" 这种很难看）。 */
function truncateChip(text, limit) {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const at = Math.max(
    cut.lastIndexOf('，'),
    cut.lastIndexOf('。'),
    cut.lastIndexOf('？'),
    cut.lastIndexOf('！'),
    cut.lastIndexOf('、'),
    cut.lastIndexOf('；'),
    cut.lastIndexOf(' '),
    cut.lastIndexOf(','),
  )
  return at >= Math.floor(limit * 0.6) ? cut.slice(0, at) : cut
}

/**
 * 解析模型吐出的多行候选。模型的排版不可控（可能带编号、引号、项目符号，
 * 也可能把几条挤在一行里用 / 或；分开），所以这里做一轮宽容清洗。
 */
function parseChips(raw, cfg, count) {
  const text = String(raw || '').replace(/\r/g, '')
  let lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length === 1 && /[／/|｜；;]/.test(lines[0])) {
    lines = lines[0].split(/[／/|｜；;]+/).map((s) => s.trim()).filter((s) => s !== '')
  }

  const items = []
  const seen = new Set()
  for (let line of lines) {
    line = line.replace(/^\s*(?:[-*•·—]+|\d+\s*[.、)）]|\(\d+\)|（\d+）)\s*/, '')
    line = line.replace(/^["'“”‘’「『]+/, '').replace(/["'“”‘’」』]+$/, '')
    line = line.replace(/\s+/g, ' ').trim()
    if (line === '') continue
    // 模型偶尔会自己加小标题或解释，这类整行丢掉。
    if (/^(?:候选|建议|可能的?(?:回复|消息|提问)|用户[:：])/.test(line) && line.length <= 12) continue
    if (line.length > cfg.chipMaxChars) line = truncateChip(line, cfg.chipMaxChars)
    const key = line.replace(/\s+/g, '')
    if (seen.has(key)) continue
    seen.add(key)
    items.push({ text: line })
    if (items.length >= count) break
  }
  return items
}

/** 取本轮的建议候选（非流式：一次拿完再给客户端渲染成按钮）。 */
async function collectSuggestions(ctx, cfg, settings, sessionId, signal, log = () => {}) {
  const llm = ctx.get('llm')
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    throw new Error('llm service unavailable')
  }
  const count = clampInt(settings.chipCount, 1, 3, DEFAULTS.chipCount)
  const { provider, model } = resolveRoute(ctx, cfg)
  const conversation = await readConversation(ctx, sessionId, cfg)
  const prompt = buildChipsPrompt(conversation.entries, cfg, count)
  log('suggest-context', {
    sessionId,
    provider,
    model,
    source: conversation.source,
    events: conversation.events,
    kept: conversation.entries.length,
    promptChars: prompt.length,
    count,
  })

  const options = {
    provider,
    model,
    system: CHIPS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens: cfg.chipsMaxTokens,
    temperature: cfg.chipsTemperature,
    signal,
    sessionId,
  }
  if (cfg.reasoningEffort !== '') options.reasoningEffort = cfg.reasoningEffort

  const started = Date.now()
  let raw = ''
  let finish = ''
  for await (const chunk of llm.stream(options)) {
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      raw += chunk.text
    } else if (chunk.type === 'finish') {
      const reason = chunk.reason
      const kind = reason !== null && typeof reason === 'object' && typeof reason.kind === 'string' ? reason.kind : 'unknown'
      finish = kind
      if (kind === 'error') {
        const failure = reason.failure
        if (!isNoContentFailure(failure)) throw new Error(`model error: ${describeFailure(failure)}`)
        finish = 'empty'
      }
    }
  }

  const items = parseChips(raw, cfg, count)
  log('suggest-done', {
    sessionId,
    finish,
    items: items.length,
    rawChars: raw.length,
    rawHead: raw.slice(0, 200),
    elapsedMs: Date.now() - started,
  })
  return { items, provider, model, source: conversation.source, elapsedMs: Date.now() - started }
}

/* ------------------------------------------------------------------ */
/* 模型调用                                                            */
/* ------------------------------------------------------------------ */

function resolveRoute(ctx, cfg) {
  let provider = cfg.provider
  let model = cfg.model
  if (provider !== '' && model !== '') return { provider, model }
  const dm = ctx.get('agentDefaultModel')
  let selection = null
  try {
    if (dm !== undefined && dm !== null && typeof dm.currentSelection === 'function') {
      selection = dm.currentSelection()
    }
  } catch {
    selection = null
  }
  if (selection !== null && typeof selection === 'object') {
    if (provider === '' && typeof selection.provider === 'string') provider = selection.provider
    if (model === '' && typeof selection.model === 'string') model = selection.model
  }
  if (provider === '') provider = 'deepseek-account'
  if (model === '') model = 'deepseek-flash'
  return { provider, model }
}

/**
 * 流式产出预测文本增量。
 * @param {object} ctx - 注入 webServer 后的上下文（用来取 llm / sessionQuery）。
 * @param {object} cfg - 归一化后的配置。
 * @param {string} sessionId - 目标会话。
 * @param {string} draft - 光标前的草稿文本（'' 表示输入框为空）。
 * @param {AbortSignal} signal - 取消信号。
 * @param {Function} log - 诊断日志函数。
 */
async function* streamPrediction(ctx, cfg, sessionId, draft, signal, log = () => {}) {
  const llm = ctx.get('llm')
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    throw new Error('llm service unavailable')
  }
  const { provider, model } = resolveRoute(ctx, cfg)
  const conversation = await readConversation(ctx, sessionId, cfg)
  const prompt = buildPrompt(conversation.entries, draft, cfg)
  const system = cfg.styleHint === '' ? SYSTEM_PROMPT : `${SYSTEM_PROMPT}\n\n【这位用户的额外习惯】\n${cfg.styleHint}`
  log('context', {
    sessionId,
    provider,
    model,
    source: conversation.source,
    events: conversation.events,
    kept: conversation.entries.length,
    promptChars: prompt.length,
  })

  const options = {
    provider,
    model,
    system,
    // DSH 的消息契约是「内容块数组」：content: [{ type: 'text', text }]。
    // 传纯字符串会让 Messages 序列化器在 content.flatMap 上抛 TypeError，
    // 外层只看到 "DeepSeek Messages transport failed" —— 别改回字符串。
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens: cfg.maxTokens,
    temperature: cfg.temperature,
    signal,
    sessionId,
  }
  if (cfg.stopAtNewline) options.stop = ['\n']
  // 不传就是 provider 默认（deepseek 是 high = 开思考），会把 maxTokens 全烧在
  // 思考上、一个 text-delta 都不吐。补全任务必须显式压低。
  if (cfg.reasoningEffort !== '') options.reasoningEffort = cfg.reasoningEffort

  const stream = llm.stream(options)
  let raw = ''
  let reasoningChunks = 0
  let reasoningChars = 0
  let finish = ''
  for await (const chunk of stream) {
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      raw += chunk.text
      yield { delta: chunk.text, raw, route: { provider, model }, source: conversation.source }
    } else if (typeof chunk.type === 'string' && /reason|think/i.test(chunk.type)) {
      // 思考增量走独立 chunk 类型，不进 raw，但要计数——否则「空预测」无从解释。
      reasoningChunks += 1
      const text = typeof chunk.text === 'string' ? chunk.text : typeof chunk.delta === 'string' ? chunk.delta : ''
      reasoningChars += text.length
    } else if (chunk.type === 'finish') {
      const reason = chunk.reason
      if (reason !== null && typeof reason === 'object') {
        finish = typeof reason.kind === 'string' ? reason.kind : 'unknown'
      }
      if (reason !== null && typeof reason === 'object' && reason.kind === 'error') {
        const failure = reason.failure
        if (isNoContentFailure(failure)) {
          // 模型明确「什么都不说」（transport 报 EMPTY_RESPONSE）。
          // 对补全来说这是合法结果——就是没有建议——不能当成错误抛出去，
          // 否则客户端会当成失败并重试。
          finish = 'empty'
        } else {
          // failure 里往往只有 message/code/status；cause 才是真正的异常，
          // 一并写进日志，否则「transport failed」这种笼统错误无从下手。
          throw new Error(`model error: ${describeFailure(failure)}`)
        }
      }
      if (reason !== null && typeof reason === 'object' && reason.kind === 'aborted' && raw === '') {
        throw new Error('aborted')
      }
    }
  }
  log('stream-done', {
    sessionId,
    finish,
    reasoningEffort: cfg.reasoningEffort === '' ? '(provider default)' : cfg.reasoningEffort,
    maxTokens: cfg.maxTokens,
    reasoningChunks,
    reasoningChars,
    rawChars: raw.length,
    rawHead: raw.slice(0, 120),
  })
}

/* ------------------------------------------------------------------ */
/* 插件                                                                */
/* ------------------------------------------------------------------ */

export default {
  name: 'dsh-input-prediction',

  apply(root, rawConfig = {}) {
    const cfg = normalizeConfig(rawConfig)
    const log = makeLogger(cfg)
    const disposers = []
    /** 每个会话只保留一个在飞的预测：新的来了就把旧的掐掉。 */
    const inflight = new Map()
    /** 同上，但用于建议候选（两种请求互不干扰）。 */
    const inflightSuggest = new Map()

    // 用户偏好（设置面板）优先于 patch 里的部署默认值。
    const settingsPath = resolveSettingsPath(cfg)
    const settings = pickSettings(cfg, readSettingsFile(settingsPath))
    const saveSettings = () => {
      try {
        writeSettingsFile(settingsPath, { version: 1, ...settings })
      } catch (err) {
        log('settings-write-failed', { path: settingsPath, error: String((err && err.message) || err) })
      }
    }
    log('settings', { path: settingsPath, ...settings })

    log('boot', {
      pid: process.pid,
      enabled: cfg.enabled,
      debugLog: cfg.debugLog,
      provider: cfg.provider === '' ? '(default)' : cfg.provider,
      model: cfg.model === '' ? '(default)' : cfg.model,
      reasoningEffort: cfg.reasoningEffort === '' ? '(provider default)' : cfg.reasoningEffort,
      maxTokens: cfg.maxTokens,
      contextMessages: cfg.contextMessages,
      contextChars: cfg.contextChars,
      maxSuggestionChars: cfg.maxSuggestionChars,
    })

    root.effect(() => () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* 卸载期的清理失败不影响其它 disposer */
        }
      }
      for (const controller of inflight.values()) {
        try {
          controller.abort()
        } catch {
          /* ignore */
        }
      }
      inflight.clear()
      for (const controller of inflightSuggest.values()) {
        try {
          controller.abort()
        } catch {
          /* ignore */
        }
      }
      inflightSuggest.clear()
    })

    root.inject(['webServer'], (ctx) => {
      const trustedHosts = new Set(
        String(process.env.DSH_INPUT_PREDICTION_TRUSTED_HOSTS || '')
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      )

      // connection 必须每次现查：插件在宿主启动早期加载，那一刻它往往还没注册。
      function connectionOf() {
        try {
          return ctx.get('connection')
        } catch {
          return undefined
        }
      }

      /** 浏览器信任栅栏：返回 HTTP 状态码表示拒绝，null 表示放行（fail-closed）。 */
      function rejectionOf(req) {
        const site = String(req.headers['sec-fetch-site'] || '').toLowerCase()
        if (site === 'cross-site') return 403

        const host = String(req.headers.host || '')
          .trim()
          .toLowerCase()
        const hostname = hostnameOf(host)
        if (!isLoopbackHostname(hostname) && !trustedHosts.has(hostname)) return 403

        const origin = req.headers.origin
        if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
          let originHost
          try {
            originHost = new URL(origin).host.toLowerCase()
          } catch {
            return 403
          }
          if (originHost !== host) return 403
        }

        const connection = connectionOf()
        if (connection === undefined || typeof connection.requestRejection !== 'function') return null
        let code
        try {
          code = connection.requestRejection(req)
        } catch {
          return 403
        }
        if (code === undefined || code === null || code === false) return null
        return typeof code === 'number' ? code : 403
      }

      function registerRoute(route) {
        const inner = route.handler
        disposers.push(
          ctx.webServer.register({
            ...route,
            handler: async (req, res) => {
              const code = rejectionOf(req)
              if (code !== null) {
                log('request-rejected', { path: route.path, code, method: req.method })
                sendJson(res, code, { ok: false, error: `request rejected (${code})` })
                return
              }
              log('request', { path: route.path, method: req.method })
              try {
                return await inner(req, res)
              } catch (err) {
                log('request-failed', { path: route.path, error: String((err && err.message) || err) })
                try {
                  if (!res.headersSent) {
                    sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
                  } else {
                    res.end()
                  }
                } catch {
                  /* 已经断开就算了 */
                }
                return undefined
              }
            },
          }),
        )
      }

      // —— 自检：客户端半区回报自己活着（加载成功 / 接受补全 / 出错）——
      registerRoute({
        kind: 'exact',
        path: TELEMETRY_ROUTE,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'POST required' })
            return
          }
          let body
          try {
            body = await readJsonBody(req, 16 * 1024)
          } catch {
            body = {}
          }
          const event = typeof body.event === 'string' ? body.event.slice(0, 64) : 'unknown'
          const detail = body.detail !== null && typeof body.detail === 'object' ? body.detail : {}
          log(`client:${event}`, {
            sessionId: typeof detail.sessionId === 'string' ? detail.sessionId : undefined,
            detail: JSON.stringify(detail).slice(0, 600),
          })
          sendJson(res, 200, { ok: true })
        },
      })

      // —— 自检：只读 ——
      registerRoute({
        kind: 'exact',
        path: HELLO_ROUTE,
        handler: (req, res) => {
          const llm = ctx.get('llm')
          const sq = ctx.get('sessionQuery')
          sendJson(res, 200, {
            ok: true,
            enabled: cfg.enabled,
            route: resolveRoute(ctx, cfg),
            predictUrl: PREDICT_ROUTE,
            suggestUrl: SUGGEST_ROUTE,
            settingsUrl: SETTINGS_ROUTE,
            settings: { ...settings },
            settingsItems: SETTINGS_ITEMS,
            contextMessages: cfg.contextMessages,
            contextChars: cfg.contextChars,
            maxSuggestionChars: cfg.maxSuggestionChars,
            chipMaxChars: cfg.chipMaxChars,
            services: {
              llm: llm !== undefined && llm !== null,
              sessionQuery: sq !== undefined && sq !== null,
            },
          })
        },
      })

      // —— 自检：看看本半区从会话里读到了什么（只读，不调模型）——
      registerRoute({
        kind: 'exact',
        path: TRANSCRIPT_ROUTE,
        handler: async (req, res) => {
          const url = new URL(req.url || TRANSCRIPT_ROUTE, 'http://localhost')
          const sessionId = url.searchParams.get('sessionId') || ''
          const conversation = await readConversation(ctx, sessionId, cfg)
          sendJson(res, 200, {
            ok: true,
            sessionId,
            source: conversation.source,
            events: conversation.events,
            total: conversation.total,
            entries: conversation.entries.map((e) => ({
              role: e.role,
              text: e.text.length > 200 ? `${e.text.slice(0, 200)}…` : e.text,
            })),
          })
        },
      })

      // —— 设置面板：读 / 写用户偏好（只认白名单里的 key）——
      registerRoute({
        kind: 'exact',
        path: SETTINGS_ROUTE,
        handler: async (req, res) => {
          const method = String(req.method || 'GET').toUpperCase()
          if (method === 'GET') {
            sendJson(res, 200, {
              ok: true,
              settings: { ...settings },
              items: SETTINGS_ITEMS,
              path: settingsPath,
              deployDefaults: {
                completionEnabled: cfg.completionEnabled,
                chipsEnabled: cfg.chipsEnabled,
                chipCount: cfg.chipCount,
                enabled: cfg.enabled,
              },
              route: resolveRoute(ctx, cfg),
            })
            return
          }
          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'GET or POST required' })
            return
          }
          const contentType = String(req.headers['content-type'] || '').toLowerCase()
          if (!contentType.includes('application/json')) {
            sendJson(res, 415, { ok: false, error: 'application/json required' })
            return
          }
          let body
          try {
            body = await readJsonBody(req)
          } catch (err) {
            sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
            return
          }
          const incoming = body !== null && typeof body === 'object' && body.settings !== null && typeof body.settings === 'object'
            ? body.settings
            : body
          const changed = []
          for (const item of SETTINGS_ITEMS) {
            const value = incoming === null || typeof incoming !== 'object' ? undefined : incoming[item.key]
            if (value === undefined || value === null) continue
            if (item.kind === 'boolean') {
              if (typeof value !== 'boolean') {
                sendJson(res, 400, { ok: false, error: `${item.key} must be a boolean` })
                return
              }
              settings[item.key] = value
            } else if (item.kind === 'number') {
              const n = Number(value)
              if (!Number.isFinite(n)) {
                sendJson(res, 400, { ok: false, error: `${item.key} must be a number` })
                return
              }
              settings[item.key] = clampInt(n, item.min, item.max, settings[item.key])
            }
            changed.push(item.key)
          }
          if (changed.length === 0) {
            sendJson(res, 400, { ok: false, error: 'no known setting in request' })
            return
          }
          saveSettings()
          log('settings-updated', { changed, ...settings })
          sendJson(res, 200, { ok: true, settings: { ...settings }, changed, path: settingsPath })
        },
      })

      // —— 建议候选：POST + JSON，一次拿完整结果 ——
      registerRoute({
        kind: 'exact',
        path: SUGGEST_ROUTE,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'POST required' })
            return
          }
          const contentType = String(req.headers['content-type'] || '').toLowerCase()
          if (!contentType.includes('application/json')) {
            sendJson(res, 415, { ok: false, error: 'application/json required' })
            return
          }
          if (!cfg.enabled || settings.chipsEnabled === false) {
            sendJson(res, 200, { ok: true, enabled: false, items: [] })
            return
          }
          let body
          try {
            body = await readJsonBody(req)
          } catch (err) {
            sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
            return
          }
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          if (sessionId === '') {
            sendJson(res, 400, { ok: false, error: 'sessionId is required' })
            return
          }
          if (body.chipCount !== undefined) {
            settings.chipCount = clampInt(body.chipCount, 1, 3, settings.chipCount)
          }
          log('suggest', { sessionId, chipCount: settings.chipCount })

          const previous = inflightSuggest.get(sessionId)
          if (previous !== undefined) {
            try {
              previous.abort()
            } catch {
              /* ignore */
            }
          }
          const controller = new AbortController()
          inflightSuggest.set(sessionId, controller)
          const timer = setTimeout(() => {
            try {
              controller.abort()
            } catch {
              /* ignore */
            }
          }, REQUEST_TIMEOUT_MS)
          let closed = false
          req.on('close', () => {
            closed = true
            try {
              controller.abort()
            } catch {
              /* ignore */
            }
          })

          try {
            const result = await collectSuggestions(ctx, cfg, settings, sessionId, controller.signal, log)
            if (closed) return
            sendJson(res, 200, {
              ok: true,
              enabled: true,
              items: result.items,
              route: { provider: result.provider, model: result.model },
              source: result.source,
              elapsedMs: result.elapsedMs,
            })
          } catch (err) {
            const message = String((err && err.message) || err)
            log('suggest-error', { sessionId, error: message, aborted: controller.signal.aborted })
            if (!closed && !controller.signal.aborted) {
              sendJson(res, 502, { ok: false, items: [], error: message })
            }
          } finally {
            clearTimeout(timer)
            if (inflightSuggest.get(sessionId) === controller) inflightSuggest.delete(sessionId)
          }
        },
      })

      // —— 预测：POST + JSON，NDJSON 流式返回 ——
      registerRoute({
        kind: 'exact',
        path: PREDICT_ROUTE,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'POST required' })
            return
          }
          const contentType = String(req.headers['content-type'] || '').toLowerCase()
          if (!contentType.includes('application/json')) {
            sendJson(res, 415, { ok: false, error: 'application/json required' })
            return
          }
          if (!cfg.enabled || settings.completionEnabled === false) {
            sendJson(res, 200, { ok: true, enabled: false, suggestion: '' })
            return
          }

          let body
          try {
            body = await readJsonBody(req)
          } catch (err) {
            sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
            return
          }

          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          const draft = typeof body.draft === 'string' ? body.draft.slice(-4000) : ''

          if (sessionId === '') {
            sendJson(res, 400, { ok: false, error: 'sessionId is required' })
            return
          }

          log('predict', { sessionId, draft, draftLen: draft.length })

          const previous = inflight.get(sessionId)
          if (previous !== undefined) {
            try {
              previous.abort()
            } catch {
              /* ignore */
            }
          }
          const controller = new AbortController()
          inflight.set(sessionId, controller)
          const timer = setTimeout(() => {
            try {
              controller.abort()
            } catch {
              /* ignore */
            }
          }, REQUEST_TIMEOUT_MS)
          let closed = false
          req.on('close', () => {
            closed = true
            try {
              controller.abort()
            } catch {
              /* ignore */
            }
          })

          res.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no',
            Connection: 'keep-alive',
          })
          if (typeof res.flushHeaders === 'function') res.flushHeaders()

          const write = (payload) => {
            if (closed) return
            try {
              res.write(`${JSON.stringify(payload)}\n`)
            } catch {
              /* 客户端断开 */
            }
          }

          const started = Date.now()
          let raw = ''
          let lastSent = ''
          try {
            for await (const step of streamPrediction(ctx, cfg, sessionId, draft, controller.signal, log)) {
              raw = step.raw
              const suggestion = sanitizeSuggestion(raw, draft, cfg)
              if (suggestion === '' || suggestion === lastSent) continue
              lastSent = suggestion
              write({
                type: 'delta',
                suggestion,
                full: `${draft}${suggestion}`,
              })
            }
            const suggestion = sanitizeSuggestion(raw, draft, cfg)
            log('predict-done', {
              sessionId,
              suggestion,
              full: `${draft}${suggestion}`,
              elapsedMs: Date.now() - started,
              aborted: controller.signal.aborted,
            })
            write({
              type: 'done',
              suggestion,
              route: resolveRoute(ctx, cfg),
              elapsedMs: Date.now() - started,
            })
          } catch (err) {
            const message = String((err && err.message) || err)
            const aborted = controller.signal.aborted || /abort/i.test(message)
            log('predict-error', {
              sessionId,
              error: message,
              code: err && err.code,
              cause: err && err.cause ? String((err.cause && err.cause.message) || err.cause) : undefined,
              stack: err && err.stack ? String(err.stack).split('\n').slice(0, 3).join(' | ') : undefined,
              aborted,
            })
            if (!aborted) write({ type: 'error', error: message })
            else write({ type: 'done', suggestion: sanitizeSuggestion(raw, draft, cfg), aborted: true })
          } finally {
            clearTimeout(timer)
            if (inflight.get(sessionId) === controller) inflight.delete(sessionId)
            try {
              res.end()
            } catch {
              /* ignore */
            }
          }
        },
      })
    })
  },
}

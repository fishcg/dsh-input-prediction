// dsh-input-prediction —— 浏览器端 half（client bundle）。
//
// 手写 CJS + ModuleLoader 包装，零构建步骤：纯 DOM 自渲染，不 import 任何
// @deepseek-ai 的值（bundle purity gate 合规）；cordis 服务经 exports.inject
// 的字符串名接入（sessions / uiSession / conversation）。
//
// 它做的事：
//   1. 盯住当前会话的输入草稿（ctx.conversation.input.for(scope).state）
//   2. 打字停顿后，把「光标前的文字」POST 给宿主半区（/dsh-input-prediction/predict）
//   3. 把流式回来的预测文本，用灰字画在光标正后方（fixed 层，不受输入框裁剪影响）
//   4. 用户按 Tab → 通过官方的 insertText(span 版本守卫) 插入到 Lexical 编辑器，
//      插入的是纯文本、可撤销、可继续编辑
//
// 关键约束（来自官方 ui-conversation 的契约）：
//   - 同一个 Session 只能有一个可编辑 root，所以绝不自建输入框，只做覆盖层
//   - 插入必须走 actions.insertText + captureInsertion（draftRev 版本守卫）
//   - Tab 在「斜杠/引用菜单打开」时归菜单；IME 组合期间一切免谈
//   - 只在光标位于草稿末尾时给建议：中间的补全没有意义，也会插错位置
window.__ModuleLoader__.load({
  id: 'dsh-input-prediction',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports

    var TAG = '[input-prediction]'
    var PREDICT_URL = '/dsh-input-prediction/predict'
    var SUGGEST_URL = '/dsh-input-prediction/suggest'
    var SETTINGS_URL = '/dsh-input-prediction/settings'
    var HELLO_URL = '/dsh-input-prediction/hello'
    var TELEMETRY_URL = '/dsh-input-prediction/telemetry'
    var VERSION = '0.2.0'
    // 热重载会再跑一次 apply()：用 window 上的这个槽判断「我是不是当前实例」。
    var INSTANCE_SLOT = '__dshInputPredictionInstance'
    var LAYER_ATTR = 'data-input-prediction-layer'
    var GHOST_ATTR = 'data-input-prediction-ghost'
    var CHIPS_ATTR = 'data-input-prediction-chips'
    var HIDDEN_ATTR = 'data-input-prediction-hidden'
    var CACHE_MS = 60 * 1000
    // 请求失败后的冷却：只压住同一个草稿的立即重试，15 秒后允许再试。
    var FAIL_TTL_MS = 15 * 1000
    var TICK_MS = 1000
    // 建议候选的最小间隔：一轮回答前后 [data-streaming] 可能翻转几次，
    // 别为同一次回复重复问模型。
    var CHIPS_MIN_INTERVAL_MS = 500
    // 设计令牌（DSH 主题里就有；离线/旧内核时退回中性色）。
    var TOKEN_BG = 'var(--dsw-alias-bg-base, rgba(127,127,127,0.06))'
    var TOKEN_BORDER = 'var(--dsw-alias-border-l1, rgba(127,127,127,0.28))'
    var TOKEN_HOVER = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.14))'
    var TOKEN_TEXT = 'var(--dsw-alias-label-primary, inherit)'
    var TOKEN_RADIUS = 'var(--dsw-radius-md, 10px)'

    function log() {
      try {
        var args = [TAG].concat(Array.prototype.slice.call(arguments))
        console.debug.apply(console, args)
      } catch (_) {
        /* ignore */
      }
    }

    function warn() {
      try {
        var args = [TAG].concat(Array.prototype.slice.call(arguments))
        console.warn.apply(console, args)
      } catch (_) {
        /* ignore */
      }
    }

    /**
     * 向宿主半区回报一条自检事件。宿主把它写进 debugLog（配置开启时）。
     * 页面的控制台用户看不见，所以这是「不打扰用户也能排障」的通道；
     * 回报失败必须完全静默——它只服务于诊断，绝不能影响预测本身。
     */
    function report(event, detail) {
      try {
        fetch(TELEMETRY_URL, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: event, detail: detail || {} }),
        }).catch(function () {
          /* 诊断通道不报错 */
        })
      } catch (_) {
        /* 诊断通道不报错 */
      }
    }

    function apply(ctx) {
      if (typeof document === 'undefined' || typeof window === 'undefined') return

      var settings = {
        enabled: true,
        /** 灰字补全（设置面板可关）。 */
        completionEnabled: true,
        /** 回复后的建议气泡（设置面板可关）。 */
        chipsEnabled: true,
        chipCount: 3,
        debounceMs: 320,
        settleMs: 520,
        minIntervalMs: 650,
        maxSuggestionChars: 60,
      }

      /** 灰字补全此刻是否工作。 */
      function completionOn() {
        return settings.enabled && settings.completionEnabled
      }

      /** 当前这条预测（key = sessionId + '\0' + 光标前文本）。 */
      var state = {
        key: '',
        suggestion: '',
        visible: '',
        token: 0,
        controller: null,
      }
      var cache = new Map()
      var layer = null
      var ghostEl = null
      var timer = null
      var lastRequestAt = 0
      var boundSessionId = ''
      var boundShell = null
      var unsubDraft = null
      var lastDraft = null
      var composing = false
      var streaming = false
      /**
       * 对话版本号。草稿字符串本身不足以做缓存键：用户把问题发出去之后，
       * 草稿又回到 ''，但对话已经往后走了一轮，「下一条」完全是另一个答案。
       * 每次「发出消息 / 回答开始 / 回答结束」都 +1，让旧缓存自然失效。
       */
      var contextEpoch = 0
      var tickTimer = null
      var measure = null
      /** 上一次已经回报过的灰字内容（避免 render 每次都被回报一遍）。 */
      var lastReportedGhost = ''
      /** 建议气泡：items 是本轮的候选，epoch 标记它们属于哪一版对话。 */
      var chips = { items: [], epoch: -1, at: 0, controller: null, container: null, host: null }
      var chipsBoot = false

      /* ---------------------------------------------------------------- */
      /* 会话 / 输入壳                                                     */
      function uiSessionFace() {
        try {
          return ctx.get('uiSession') || null
        } catch (_) {
          return null
        }
      }

      function currentSessionSource() {
        try {
          var face = uiSessionFace()
          var adapter = face !== null ? face.adapter : undefined
          var source = adapter !== undefined && adapter !== null ? adapter.current : undefined
          if (
            source !== undefined &&
            source !== null &&
            typeof source.getSnapshot === 'function' &&
            typeof source.subscribe === 'function'
          ) {
            return source
          }
        } catch (_) {
          /* 旧版内核：无 uiSession */
        }
        return null
      }

      function readCurrentSessionId() {
        try {
          var source = currentSessionSource()
          if (source !== null) {
            var binding = source.getSnapshot()
            if (binding !== undefined && binding !== null && binding.key !== undefined) return binding.key
          }
        } catch (_) {
          /* 落到下一级 */
        }
        try {
          if (typeof localStorage !== 'undefined') {
            var raw = localStorage.getItem('dsh.sessions.current')
            if (raw !== null) {
              var parsed = JSON.parse(raw)
              if (
                parsed !== null &&
                typeof parsed === 'object' &&
                typeof parsed.sessionId === 'string' &&
                parsed.sessionId !== ''
              ) {
                return parsed.sessionId
              }
            }
          }
        } catch (_) {
          /* 落到下一级 */
        }
        try {
          var sessions = ctx.get('sessions')
          var snap = sessions.list.getSnapshot()
          if (snap !== undefined && snap !== null) {
            if (typeof snap.current === 'string' && snap.current !== '') return snap.current
            var byId = snap.byId
            if (byId !== undefined && byId !== null && typeof byId === 'object') {
              var ids = Array.isArray(snap.ids) ? snap.ids : Object.keys(byId)
              for (var i = 0; i < ids.length; i += 1) {
                var record = byId[ids[i]]
                var retained = record !== undefined && record !== null ? record.retainedBy : null
                if (
                  retained !== null &&
                  retained !== undefined &&
                  typeof retained.mainView === 'number' &&
                  retained.mainView > 0
                ) {
                  return ids[i]
                }
              }
            }
          }
        } catch (_) {
          /* 落到下一级 */
        }
        return undefined
      }

      function inputShell(scope) {
        try {
          var api = ctx.get('conversation')
          if (api === undefined || api === null || api.input === undefined || api.input === null) return null
          if (typeof api.input.for !== 'function') return null
          var shell = api.input.for(scope)
          return shell === undefined ? null : shell
        } catch (err) {
          log('inputShell failed', err)
          return null
        }
      }

      function scopeOf(sessionId) {
        try {
          if (typeof sessionId !== 'string' || sessionId === '') return null
          var sessions = ctx.get('sessions')
          var scope = sessions.scope(sessionId)
          return scope === undefined ? null : scope
        } catch (_) {
          return null
        }
      }

      function draftOf(shell) {
        try {
          var snap = shell.state.getSnapshot()
          return snap !== null && snap !== undefined && typeof snap.draft === 'string' ? snap.draft : ''
        } catch (_) {
          return ''
        }
      }

      /**
       * 这一轮回答还在进行吗（含「还在思考」和「正在跑工具」）？
       * `uiSession.sessionStatus` 是内核的权威状态（composer 的停止按钮就读它），
       * 拿不到时退回「会话区里有没有正在流式的行」。
       */
      function turnRunning(sessionId) {
        try {
          var ui = ctx.get('uiSession')
          var store = ui === null || ui === undefined ? null : ui.sessionStatus
          if (store !== null && store !== undefined && typeof store.getSnapshot === 'function') {
            var snap = store.getSnapshot()
            if (snap !== null && snap !== undefined && typeof snap.get === 'function') {
              var row = snap.get(sessionId)
              if (row !== null && row !== undefined && row.running === true) return true
            }
          }
        } catch (_) {
          /* 旧版内核没有 sessionStatus：走 DOM 兜底 */
        }
        return document.querySelector('[data-streaming]') !== null
      }

      /** `client:ready` 里带一句：内核的会话状态读到了没有（排障用，不影响行为）。 */
      function turnStatusProbe() {
        try {
          var ui = ctx.get('uiSession')
          var store = ui === null || ui === undefined ? null : ui.sessionStatus
          if (store === null || store === undefined || typeof store.getSnapshot !== 'function') return 'no-store'
          var snap = store.getSnapshot()
          if (snap === null || snap === undefined || typeof snap.get !== 'function') return 'no-snapshot'
          var row = snap.get(readCurrentSessionId())
          if (row === null || row === undefined) return 'no-row/' + snap.size
          return 'running=' + String(row.running)
        } catch (err) {
          return 'error:' + String((err && err.message) || err)
        }
      }

      /* ---------------------------------------------------------------- */
      /* composer DOM                                                      */
      function composerInputs() {
        return Array.prototype.slice.call(document.querySelectorAll('[data-composer-card] [data-composer-input]'))
      }

      function activeInput() {
        var list = composerInputs()
        for (var i = list.length - 1; i >= 0; i -= 1) {
          var el = list[i]
          if (!el.isConnected) continue
          var rect = el.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) return el
        }
        return null
      }

      function isFocused(input) {
        var active = document.activeElement
        if (active === null) return false
        return active === input || (typeof input.contains === 'function' && input.contains(active))
      }

      function composingNow(input) {
        if (composing) return true
        return input.hasAttribute('data-composer-composing')
      }

      function triggerMenuOpen() {
        return document.querySelector('[data-trigger-menu]') !== null
      }

      function rectify(rect) {
        return rect !== null && rect !== undefined && rect.height > 0
      }

      /**
       * 光标处矩形。文本节点里的 range 直接可信；但 Lexical 在 setDraft/重挂 DOM
       * 之后常把选区停在**块级边界**（startContainer 是元素、offset 指向子节点），
       * 这种 range 的 rect 会退化成整块的盒子（left = 行首），灰字就会画到正文
       * 上面去。此时改用「最后一个字符的右缘」——正是末尾光标该在的位置。
       * @param {Range} range - 当前选区。
       * @param {Element} input - 编辑器根元素。
       * @param {boolean} atEnd - 光标后是否已无文字。
       * @returns {{left:number,top:number,height:number}|null} 光标矩形。
       */
      function caretRect(range, input, atEnd) {
        var rect = null
        try {
          rect = range.getBoundingClientRect()
        } catch (_) {
          rect = null
        }
        var container = range.startContainer
        var inText = container !== null && container !== undefined && container.nodeType === 3
        if (inText && rectify(rect)) return rect
        if (atEnd) {
          var tail = lastCharRect(input)
          if (tail !== null) return tail
        }
        return rectify(rect) ? rect : null
      }

      /** 编辑器末尾那个字符（或末尾空元素）的矩形。 */
      function lastCharRect(input) {
        var node = input
        while (node !== null && node !== undefined && node.lastChild !== null && node.lastChild !== undefined) {
          node = node.lastChild
        }
        if (node === null || node === undefined || node === input) return null
        try {
          if (node.nodeType === 3) {
            if (node.length === 0) {
              var empty = document.createRange()
              empty.selectNode(node)
              var emptyBox = empty.getBoundingClientRect()
              return rectify(emptyBox) ? { left: emptyBox.left, top: emptyBox.top, height: emptyBox.height } : null
            }
            var tail = document.createRange()
            tail.setStart(node, node.length - 1)
            tail.setEnd(node, node.length)
            var box = tail.getBoundingClientRect()
            if (!rectify(box)) return null
            return { left: box.right, top: box.top, height: box.height }
          }
          var el = document.createRange()
          el.selectNode(node)
          var elBox = el.getBoundingClientRect()
          if (!rectify(elBox)) return null
          return { left: elBox.left, top: elBox.top, height: elBox.height }
        } catch (_) {
          return null
        }
      }

      /** 光标处的矩形 + 光标前/后的文本。 */
      function caretSnapshot(input) {
        var selection = window.getSelection()
        if (selection === null || selection.rangeCount === 0) return null
        if (selection.isCollapsed !== true) return null
        var range = selection.getRangeAt(0)
        if (!input.contains(range.startContainer)) return null

        var before = document.createRange()
        before.selectNodeContents(input)
        try {
          before.setEnd(range.startContainer, range.startOffset)
        } catch (_) {
          return null
        }
        var after = document.createRange()
        after.selectNodeContents(input)
        try {
          after.setStart(range.endContainer, range.endOffset)
        } catch (_) {
          return null
        }

        var textBefore = before.toString()
        var textAfter = after.toString()
        // 光标后面没有任何字符 = 光标在末尾
        var atEnd = textAfter.replace(/[\s\u200b]/g, '') === ''
        var rect = caretRect(range, input, atEnd)
        if (!rectify(rect)) {
          try {
            var fallback = after.getBoundingClientRect()
            if (rectify(fallback)) rect = { left: fallback.left, top: fallback.top, height: fallback.height }
          } catch (_) {
            /* ignore */
          }
        }
        if (!rectify(rect)) {
          try {
            var box = input.getBoundingClientRect()
            var cs = window.getComputedStyle(input)
            var lineHeight = parseFloat(cs.lineHeight)
            if (!Number.isFinite(lineHeight) || lineHeight <= 0) lineHeight = parseFloat(cs.fontSize) * 1.5 || 20
            rect = { left: box.left, top: box.top, height: lineHeight }
          } catch (_) {
            return null
          }
        }
        return {
          textBefore: textBefore,
          textAfter: textAfter,
          rect: rect,
          atEnd: atEnd,
        }
      }

      function keyFor(sessionId, draft) {
        return String(sessionId || '') + '\u0000' + contextEpoch + '\u0000' + String(draft || '')
      }

      /** 对话上下文变了：作废当前提示与缓存。 */
      function bumpContext() {
        contextEpoch += 1
        cache.clear()
        chips.items = []
        hideChips()
        if (state.suggestion !== '' || state.key !== '') {
          state.suggestion = ''
          state.key = ''
          hideGhost()
        }
      }

      /* ---------------------------------------------------------------- */
      /* 画灰字                                                            */
      function ensureLayer() {
        if (layer !== null && layer.isConnected) return layer
        layer = document.createElement('div')
        layer.setAttribute(LAYER_ATTR, '')
        layer.style.cssText =
          'position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;' +
          'z-index:2147482000;contain:layout style;'
        document.body.appendChild(layer)
        return layer
      }

      function ensureGhost() {
        if (ghostEl !== null && ghostEl.isConnected) return ghostEl
        ghostEl = document.createElement('span')
        ghostEl.setAttribute(GHOST_ATTR, '')
        ghostEl.setAttribute('aria-hidden', 'true')
        ghostEl.style.cssText =
          'position:absolute;white-space:pre;pointer-events:none;' +
          'user-select:none;-webkit-user-select:none;display:none;'
        ensureLayer().appendChild(ghostEl)
        return ghostEl
      }

      function measureContext() {
        if (measure !== null) return measure
        try {
          var canvas = document.createElement('canvas')
          measure = canvas.getContext('2d')
        } catch (_) {
          measure = null
        }
        return measure
      }

      function fontOf(input, cs) {
        var size = cs.fontSize || '14px'
        var family = cs.fontFamily || 'sans-serif'
        var weight = cs.fontWeight || '400'
        var style = cs.fontStyle || 'normal'
        return style + ' ' + weight + ' ' + size + ' ' + family
      }

      /** 只显示能放得下的部分：看到什么，Tab 就插入什么。 */
      function fitText(text, font, available) {
        if (text === '' || available <= 0) return ''
        var context = measureContext()
        if (context === null) return text
        try {
          context.font = font
          if (context.measureText(text).width <= available) return text
          var lo = 0
          var hi = text.length
          while (lo < hi) {
            var mid = Math.ceil((lo + hi) / 2)
            if (context.measureText(text.slice(0, mid)).width <= available) lo = mid
            else hi = mid - 1
          }
          return text.slice(0, lo)
        } catch (_) {
          return text
        }
      }

      function hideGhost() {
        if (ghostEl !== null) ghostEl.style.display = 'none'
        state.visible = ''
        setPlaceholderHidden(false)
      }

      function setPlaceholderHidden(hidden) {
        var placeholder = document.querySelector('[data-composer-placeholder]')
        if (placeholder === null) return
        if (hidden) {
          if (!placeholder.hasAttribute(HIDDEN_ATTR)) {
            placeholder.setAttribute(HIDDEN_ATTR, '')
            placeholder.style.visibility = 'hidden'
          }
        } else if (placeholder.hasAttribute(HIDDEN_ATTR)) {
          placeholder.removeAttribute(HIDDEN_ATTR)
          placeholder.style.visibility = ''
        }
      }

      /**
       * 唯一的重绘入口：每次都重新读光标，保证「画出来的位置」= 「Tab 会插入的位置」。
       * 任何不一致（光标跑了、草稿变了、菜单开了）都直接隐藏。
       */
      function render() {
        if (!completionOn() || state.suggestion === '' || chipsShown()) {
          hideGhost()
          return
        }
        var input = activeInput()
        if (input === null || !isFocused(input) || composingNow(input) || triggerMenuOpen()) {
          hideGhost()
          return
        }
        var sessionId = readCurrentSessionId()
        if (turnRunning(sessionId)) {
          // 回答还没写完（思考/跑工具/流式）：这会儿不该出现「下一条」提示
          hideGhost()
          return
        }
        var snapshot = caretSnapshot(input)
        // textBefore 为空 = 光标前面一个字都没有：只在「补全你已经打了一半的话」时才画灰字
        if (snapshot === null || !snapshot.atEnd || snapshot.textBefore === '') {
          hideGhost()
          return
        }
        if (keyFor(sessionId, snapshot.textBefore) !== state.key) {
          // 预测针对的是别的草稿：作废（草稿变化已经排好新的预测）
          state.suggestion = ''
          hideGhost()
          return
        }

        var text = state.suggestion
        var cs = window.getComputedStyle(input)
        var font = fontOf(input, cs)
        var box = input.getBoundingClientRect()
        var padRight = parseFloat(cs.paddingRight) || 0
        var borderRight = parseFloat(cs.borderRightWidth) || 0
        var right = box.right - padRight - borderRight
        var lineHeight = snapshot.rect.height
        if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
          lineHeight = parseFloat(cs.lineHeight)
          if (!Number.isFinite(lineHeight) || lineHeight <= 0) lineHeight = parseFloat(cs.fontSize) * 1.5 || 20
        }
        var available = right - snapshot.rect.left
        if (!Number.isFinite(available) || available < 12) available = 12

        var fitted = fitText(text, font, available)
        var el = ensureGhost()
        if (fitted === '') {
          hideGhost()
          return
        }

        var placeholder = document.querySelector('[data-composer-placeholder]')
        var placeholderColor =
          placeholder !== null ? window.getComputedStyle(placeholder).color : 'rgba(127,127,127,0.9)'
        el.textContent = fitted
        el.style.display = 'block'
        el.style.left = Math.round(snapshot.rect.left) + 'px'
        el.style.top = Math.round(snapshot.rect.top) + 'px'
        el.style.height = Math.round(lineHeight) + 'px'
        el.style.lineHeight = Math.round(lineHeight) + 'px'
        el.style.fontFamily = cs.fontFamily
        el.style.fontSize = cs.fontSize
        el.style.fontWeight = cs.fontWeight
        el.style.fontStyle = cs.fontStyle
        el.style.letterSpacing = cs.letterSpacing
        el.style.color = placeholderColor
        el.style.opacity = '0.85'
        state.visible = fitted
        setPlaceholderHidden(true)
        if (fitted !== lastReportedGhost) {
          lastReportedGhost = fitted
          report('ghost', {
            sessionId: readCurrentSessionId(),
            draft: snapshot.textBefore,
            suggestion: fitted,
            displayed: `${snapshot.textBefore}${fitted}`,
          })
        }
      }

      /* ---------------------------------------------------------------- */
      /* 预测                                                              */
      function schedule(delay) {
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(function () {
          timer = null
          run()
        }, delay === undefined || delay === null ? settings.debounceMs : delay)
      }

      /** 判断此刻该不该预测；该预测就发请求。 */
      function run() {
        if (!completionOn()) return
        var input = activeInput()
        if (input === null || !isFocused(input) || composingNow(input) || triggerMenuOpen()) return
        var sessionId = readCurrentSessionId()
        if (typeof sessionId !== 'string' || sessionId === '') return
        // 回答进行中：连请求都不发（思考阶段的上下文本来也还没定下来）
        if (turnRunning(sessionId)) return
        var snapshot = caretSnapshot(input)
        if (snapshot === null || !snapshot.atEnd) return
        var draft = snapshot.textBefore
        var key = keyFor(sessionId, draft)

        // 灰字只服务于「你已经打了一半」：草稿空着时那块地方是占位文案的地盘，
        // 而且「下一条」本来就归建议气泡管 —— 两套 UI 抢同一个位置只会叠在一起。
        if (draft === '') {
          state.suggestion = ''
          hideGhost()
          return
        }

        if (state.key === key && state.suggestion !== '') {
          render()
          return
        }
        var hit = cache.get(key)
        if (hit !== undefined && Date.now() - hit.at < (hit.ttl || CACHE_MS)) {
          state.key = key
          state.suggestion = hit.suggestion
          render()
          return
        }
        if (Date.now() - lastRequestAt < settings.minIntervalMs) {
          schedule(settings.minIntervalMs)
          return
        }
        request(sessionId, draft, key)
      }

      function abortInflight() {
        if (state.controller !== null) {
          try {
            state.controller.abort()
          } catch (_) {
            /* ignore */
          }
          state.controller = null
        }
      }

      function adopt(key, suggestion, done) {
        if (state.key !== key) return
        state.suggestion = suggestion
        if (done) {
          // 空结果同样入缓存：否则用户对着同一个草稿发呆时，tick 会每隔一秒
          // 重新问一遍模型（白烧 token），命中缓存则直接跳过请求。
          cache.set(key, { suggestion: suggestion, at: Date.now() })
          trimCache()
          log('prediction ready', JSON.stringify(suggestion))
        }
        render()
      }

      function trimCache() {
        if (cache.size <= 40) return
        var entries = Array.from(cache.entries()).sort(function (a, b) {
          return a[1].at - b[1].at
        })
        for (var i = 0; i < entries.length - 30; i += 1) cache.delete(entries[i][0])
      }

      function handleLine(key, line) {
        if (line === '') return
        var payload = null
        try {
          payload = JSON.parse(line)
        } catch (_) {
          return
        }
        if (payload === null || typeof payload !== 'object') return
        if (payload.type === 'delta') {
          adopt(key, typeof payload.suggestion === 'string' ? payload.suggestion : '', false)
        } else if (payload.type === 'done') {
          adopt(key, typeof payload.suggestion === 'string' ? payload.suggestion : '', true)
        } else if (payload.type === 'error') {
          warn('host error', payload.error)
          report('host-error', { error: String(payload.error || '') })
          // 请求失败也要记一笔短冷却：否则对着同一个草稿发呆时，tick 会每秒重试一次。
          cache.set(key, { suggestion: '', at: Date.now(), ttl: FAIL_TTL_MS })
        }
      }

      function request(sessionId, draft, key) {
        abortInflight()
        var token = state.token + 1
        state.token = token
        state.key = key
        state.suggestion = ''
        render()
        lastRequestAt = Date.now()

        var controller = new AbortController()
        state.controller = controller

        fetch(PREDICT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId, draft: draft }),
          signal: controller.signal,
          credentials: 'same-origin',
          cache: 'no-store',
        })
          .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status)
            if (response.body === null || typeof response.body.getReader !== 'function') {
              return response.text().then(function (text) {
                text.split('\n').forEach(function (line) {
                  handleLine(key, line.trim())
                })
              })
            }
            var reader = response.body.getReader()
            var decoder = new TextDecoder()
            var buffer = ''
            function pump() {
              return reader.read().then(function (result) {
                if (result.done === true) {
                  if (buffer.trim() !== '') handleLine(key, buffer.trim())
                  return undefined
                }
                buffer += decoder.decode(result.value, { stream: true })
                var index = buffer.indexOf('\n')
                while (index !== -1) {
                  handleLine(key, buffer.slice(0, index).trim())
                  buffer = buffer.slice(index + 1)
                  index = buffer.indexOf('\n')
                }
                return pump()
              })
            }
            return pump()
          })
          .catch(function (err) {
            if (controller.signal.aborted) return
            warn('predict failed', err && err.message ? err.message : err)
            report('predict-failed', {
              sessionId: sessionId,
              draft: draft,
              error: String((err && err.message) || err),
            })
          })
          .then(function () {
            if (state.controller === controller) state.controller = null
          })
      }

      /* ---------------------------------------------------------------- */
      /* 接受（Tab）                                                       */
      function accept(text) {
        if (text === '') return
        var sessionId = readCurrentSessionId()
        var scope = scopeOf(sessionId)
        var shell = scope === null ? null : inputShell(scope)
        if (shell === null || shell.actions === undefined || shell.actions === null) {
          warn('no input shell; cannot insert')
          report('accept-failed', { sessionId: sessionId, reason: 'no input shell' })
          return
        }
        var applied = false
        try {
          var span = shell.actions.captureInsertion()
          applied = shell.actions.insertText(text, span) === true
        } catch (err) {
          warn('insertText threw', err)
          applied = false
        }
        var how = applied ? 'insertText' : ''
        if (!applied) {
          // 版本守卫拒绝（草稿在飞行中被改过）：退回整体改写草稿
          try {
            var draft = draftOf(shell)
            shell.actions.setDraft(draft + text)
            applied = true
            how = 'setDraft'
          } catch (err) {
            warn('setDraft threw', err)
          }
        }
        report(applied ? 'accept' : 'accept-failed', {
          sessionId: sessionId,
          how: how === '' ? 'none' : how,
          text: text,
        })
        if (!applied) return
        cache.delete(state.key)
        state.suggestion = ''
        state.visible = ''
        hideGhost()
        schedule(160)
      }

      function onKeyDown(event) {
        if (event.key !== 'Tab' || event.defaultPrevented) return
        if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
        if (event.isComposing === true || event.keyCode === 229) return
        if (state.visible === '') return
        var input = activeInput()
        if (input === null) return
        var target = event.target
        if (target !== input && !(typeof input.contains === 'function' && input.contains(target))) return
        if (triggerMenuOpen()) return
        var sessionId = readCurrentSessionId()
        var snapshot = caretSnapshot(input)
        if (snapshot === null || !snapshot.atEnd) return
        if (keyFor(sessionId, snapshot.textBefore) !== state.key) return
        event.preventDefault()
        event.stopPropagation()
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
        log('accept', JSON.stringify(state.visible))
        accept(state.visible)
      }

      /* ---------------------------------------------------------------- */
      /* 建议气泡（每轮回答结束后：1–3 条可点击直接发送的候选）                */
      /** 气泡此刻是不是真的画在屏幕上（= 草稿空着、回答已结束那段时间）。 */
      function chipsShown() {
        return (
          chips.container !== null &&
          chips.container.isConnected &&
          chips.container.style.display !== 'none' &&
          chips.items.length > 0
        )
      }

      function hideChips() {
        if (chips.container !== null && chips.container.isConnected) chips.container.style.display = 'none'
      }

      /** 丢掉候选。markEpoch=true 表示「这一轮已经问过了」，别在同一个 epoch 里重问。 */
      function clearChips(markEpoch) {
        chips.items = []
        if (markEpoch === true) chips.epoch = contextEpoch
        hideChips()
      }

      function ensureChips() {
        if (chips.container !== null && chips.container.isConnected) return chips.container
        var box = document.createElement('div')
        box.setAttribute(CHIPS_ATTR, '')
        box.style.cssText =
          'display:none;flex-wrap:wrap;gap:8px;align-items:center;justify-content:center;' +
          'pointer-events:auto;max-width:100%;'
        if (chips.host !== null && chips.host.isConnected) {
          // 官方槽 conversation.input.dock：跟着布局走，不会压到别的面板
          chips.host.appendChild(box)
        } else {
          // 兜底：槽还没挂上时先自绘浮层（可能和别的 dock 面板重叠，只当过渡）
          box.style.position = 'absolute'
          box.style.justifyContent = 'flex-start'
          ensureLayer().appendChild(box)
        }
        chips.container = box
        return box
      }

      function chipButton(text) {
        var el = document.createElement('button')
        el.type = 'button'
        el.setAttribute('data-input-prediction-chip', '')
        el.textContent = text
        el.title = '点击直接发送：' + text
        el.style.cssText =
          'pointer-events:auto;cursor:pointer;font:inherit;font-size:13px;line-height:18px;' +
          'padding:6px 12px;border-radius:999px;border:1px solid ' + TOKEN_BORDER + ';' +
          'background:' + TOKEN_BG + ';color:' + TOKEN_TEXT + ';white-space:nowrap;' +
          'overflow:hidden;text-overflow:ellipsis;max-width:100%;transition:background .12s ease;'
        el.addEventListener('mouseenter', function () {
          el.style.background = TOKEN_HOVER
        })
        el.addEventListener('mouseleave', function () {
          el.style.background = TOKEN_BG
        })
        el.addEventListener('click', function (event) {
          event.preventDefault()
          event.stopPropagation()
          sendText(text)
        })
        return el
      }

      function dismissButton() {
        var el = document.createElement('button')
        el.type = 'button'
        el.textContent = '×'
        el.title = '收起这些建议'
        el.style.cssText =
          'pointer-events:auto;cursor:pointer;font:inherit;font-size:14px;line-height:16px;' +
          'width:24px;height:24px;padding:0;border-radius:50%;border:1px solid ' + TOKEN_BORDER + ';' +
          'background:transparent;color:' + TOKEN_TEXT + ';opacity:.55;'
        el.addEventListener('click', function (event) {
          event.preventDefault()
          event.stopPropagation()
          clearChips(true)
          report('chips-dismissed', {})
        })
        return el
      }

      /**
       * 画建议气泡。位置锚在 composer 卡片正上方（fixed 层，卡片自身的裁剪/层叠
       * 上下文管不到这里）；草稿非空、正在回答、会话不匹配时一律隐藏。
       */
      function renderChips() {
        if (
          !settings.enabled ||
          !settings.chipsEnabled ||
          chips.items.length === 0 ||
          streaming ||
          turnRunning(boundSessionId)
        ) {
          hideChips()
          return
        }
        if (typeof boundSessionId !== 'string' || boundSessionId === '') {
          hideChips()
          return
        }
        if (readCurrentSessionId() !== boundSessionId) {
          hideChips()
          return
        }
        if (boundShell !== null && draftOf(boundShell).trim() !== '') {
          hideChips()
          return
        }
        var inFlow = chips.host !== null && chips.host.isConnected
        var card = document.querySelector('[data-composer-card]')
        var rect = card === null ? null : card.getBoundingClientRect()
        if (!inFlow && (rect === null || !(rect.width > 0 && rect.height > 0))) {
          hideChips()
          return
        }
        var box = ensureChips()
        box.textContent = ''
        for (var i = 0; i < chips.items.length; i += 1) box.appendChild(chipButton(chips.items[i].text))
        box.appendChild(dismissButton())
        box.style.display = 'flex'
        if (inFlow) {
          // 走官方槽：位置归布局，但宽度对齐输入框卡片，气泡从输入框文字的左边缘开始排
          if (rect !== null && rect.width > 0) chips.host.style.width = Math.round(rect.width) + 'px'
          box.style.justifyContent = 'flex-start'
          box.style.left = ''
          box.style.width = ''
          box.style.bottom = ''
        } else {
          box.style.left = Math.round(rect.left + 12) + 'px'
          box.style.width = Math.round(Math.max(200, rect.width - 24)) + 'px'
          box.style.bottom = Math.round(window.innerHeight - rect.top + 10) + 'px'
        }
      }

      /** 取本轮的建议候选（一轮一次）。 */
      function requestChips() {
        if (!settings.enabled || !settings.chipsEnabled) {
          clearChips(true)
          return
        }
        var sessionId = readCurrentSessionId()
        if (typeof sessionId !== 'string' || sessionId === '' || sessionId !== boundSessionId) return
        if (turnRunning(sessionId)) return
        if (boundShell !== null && draftOf(boundShell).trim() !== '') return
        if (chips.epoch === contextEpoch) {
          renderChips()
          return
        }
        if (Date.now() - chips.at < CHIPS_MIN_INTERVAL_MS) return
        chips.at = Date.now()
        if (chips.controller !== null) {
          try {
            chips.controller.abort()
          } catch (_) {
            /* ignore */
          }
        }
        var controller = new AbortController()
        chips.controller = controller
        var epoch = contextEpoch
        fetch(SUGGEST_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
          body: JSON.stringify({ sessionId: sessionId }),
          signal: controller.signal,
        })
          .then(function (response) {
            return response.ok ? response.json() : null
          })
          .then(function (info) {
            if (chips.controller === controller) chips.controller = null
            if (info === null || typeof info !== 'object') return
            if (info.enabled === false) {
              clearChips(true)
              return
            }
            // 拿到结果时对话又往前走了一轮 —— 这批候选已经过时，丢掉。
            if (epoch !== contextEpoch) return
            var items = Array.isArray(info.items) ? info.items : []
            chips.items = items
              .filter(function (item) {
                return item !== null && typeof item === 'object' && typeof item.text === 'string' && item.text !== ''
              })
              .slice(0, settings.chipCount)
            chips.epoch = epoch
            renderChips()
            // 报告里带上「真的画出来了吗」，否则日志里只有请求成功、看不出视觉结果
            var box = chips.container
            var shown = box !== null && box.isConnected && box.style.display !== 'none'
            var boxRect = null
            if (shown) {
              var r = box.getBoundingClientRect()
              boxRect = {
                x: Math.round(r.left),
                y: Math.round(r.top),
                w: Math.round(r.width),
                h: Math.round(r.height),
              }
            }
            report('chips', {
              sessionId: sessionId,
              count: chips.items.length,
              visible: shown,
              rect: boxRect,
              items: chips.items.map(function (item) {
                return item.text
              }),
            })
          })
          .catch(function (err) {
            if (chips.controller === controller) chips.controller = null
            if (controller.signal.aborted) return
            report('chips-failed', { sessionId: sessionId, error: String((err && err.message) || err) })
          })
      }

      /**
       * 点一下候选 = 直接发送：先把文字写进草稿，等编辑器投影真的更新了再提交
       * （Lexical 的 update 是异步提交的，submit 读的是投影，早一步就发出去空消息）。
       */
      function sendText(text) {
        clearChips(false)
        var sessionId = readCurrentSessionId()
        var scope = scopeOf(sessionId)
        var shell = scope === null ? null : inputShell(scope)
        if (shell === null || shell.actions === undefined || shell.actions === null) {
          report('chip-send-failed', { sessionId: sessionId, reason: 'no input shell' })
          return
        }
        var started = Date.now()
        var attempts = 0
        var wrote = false
        function attempt() {
          attempts += 1
          var draft = draftOf(shell)
          if (draft.trim() === '') {
            if (Date.now() - started < 1500 && attempts < 25) {
              if (!wrote) {
                try {
                  shell.actions.setDraft(text)
                  wrote = true
                } catch (err) {
                  warn('setDraft threw', err)
                }
              }
              setTimeout(attempt, 60)
              return
            }
            report('chip-send-failed', { sessionId: sessionId, reason: 'draft not set', wrote: wrote })
            return
          }
          var submitted = false
          try {
            shell.actions.submit()
            submitted = true
          } catch (err) {
            warn('submit threw', err)
            report('chip-send-failed', {
              sessionId: sessionId,
              reason: String((err && err.message) || err),
            })
          }
          if (submitted) {
            log('chip sent', JSON.stringify(draft))
            report('chip-send', { sessionId: sessionId, text: draft, attempts: attempts })
          }
        }
        setTimeout(attempt, 40)
      }

      /* ---------------------------------------------------------------- */
      /* 设置面板（「插件设置」里的一个标签页）                                */
      var SETTINGS_KEYS = ['completionEnabled', 'chipsEnabled', 'chipCount']
      var slotDisposer = null
      var slotTries = 0
      var chipsDisposer = null
      var chipsTries = 0
      var React = null
      try {
        // 平台模块：第三方 bundle 也能解析到（与 dsh-client-ui-primitives 同一套解析）
        React = require('react')
      } catch (err) {
        React = null
      }

      /** 「插件设置」标签页：两个开关 + 推荐条数。 */
      function SettingsTab() {
        var h = React.createElement
        var infoPair = React.useState(null)
        var info = infoPair[0]
        var setInfo = infoPair[1]
        var busyPair = React.useState('')
        var busy = busyPair[0]
        var setBusy = busyPair[1]
        var errPair = React.useState('')
        var error = errPair[0]
        var setError = errPair[1]

        React.useEffect(function () {
          var alive = true
          fetch(SETTINGS_URL, { credentials: 'same-origin', cache: 'no-store' })
            .then(function (response) {
              return response.ok ? response.json() : null
            })
            .then(function (data) {
              if (!alive) return
              if (data === null || typeof data !== 'object') {
                setError('读不到设置（宿主半区没回应）')
                return
              }
              setInfo(data)
            })
            .catch(function () {
              if (alive) setError('读不到设置（宿主半区没回应）')
            })
          return function () {
            alive = false
          }
        }, [])

        function save(patch) {
          setBusy(Object.keys(patch)[0])
          setError('')
          fetch(SETTINGS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
            body: JSON.stringify({ settings: patch }),
          })
            .then(function (response) {
              return response.ok ? response.json() : null
            })
            .then(function (data) {
              setBusy('')
              if (data === null || typeof data !== 'object' || data.ok !== true) {
                setError('保存失败')
                return
              }
              var saved = data.settings === undefined ? patch : data.settings
              // 本地立即生效：灰字与推荐气泡都不用刷新页面
              for (var i = 0; i < SETTINGS_KEYS.length; i += 1) {
                var key = SETTINGS_KEYS[i]
                if (saved[key] !== undefined) settings[key] = saved[key]
              }
              setInfo(function (prev) {
                var base = prev === null ? {} : prev
                return {
                  settings: Object.assign({}, base.settings || {}, saved),
                  items: base.items || [],
                  path: base.path,
                  route: base.route,
                }
              })
              if (saved.completionEnabled === false || saved.chipsEnabled === false) hideGhost()
              if (saved.chipsEnabled === false) clearChips(true)
              render()
              renderChips()
              report('settings-updated', { changed: patch })
            })
            .catch(function (err) {
              setBusy('')
              setError(String((err && err.message) || err))
            })
        }

        var current = Object.assign({}, settings, info !== null && info.settings ? info.settings : {})

        function switchRow(key, title, hint) {
          var on = current[key] !== false
          var disabled = busy !== ''
          return h(
            'div',
            {
              key: key,
              style: {
                display: 'flex',
                alignItems: 'flex-start',
                gap: '12px',
                padding: '12px 0',
                borderTop: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.08))',
              },
            },
            h(
              'div',
              { style: { flex: '1 1 auto', minWidth: 0 } },
              h('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-primary, #e8e8e8)' } }, title),
              h(
                'div',
                {
                  style: {
                    fontSize: '12px',
                    lineHeight: '18px',
                    marginTop: '2px',
                    color: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
                  },
                },
                hint,
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                disabled: disabled,
                'aria-pressed': on ? 'true' : 'false',
                onClick: function () {
                  var patch = {}
                  patch[key] = !on
                  save(patch)
                },
                style: {
                  flex: '0 0 auto',
                  position: 'relative',
                  width: '40px',
                  height: '22px',
                  padding: 0,
                  borderRadius: '999px',
                  cursor: disabled ? 'default' : 'pointer',
                  border:
                    '1px solid ' +
                    (on
                      ? 'var(--dsw-alias-state-business-primary, #4d8dff)'
                      : 'var(--dsw-alias-border-l1, rgba(255,255,255,.18))'),
                  background: on ? 'var(--dsw-alias-state-business-primary, #4d8dff)' : 'transparent',
                  transition: 'background .15s ease',
                },
              },
              h('span', {
                style: {
                  position: 'absolute',
                  top: '2px',
                  left: on ? '20px' : '2px',
                  width: '16px',
                  height: '16px',
                  borderRadius: '50%',
                  background: on ? '#fff' : 'var(--dsw-alias-label-tertiary, #8b8b8b)',
                  transition: 'left .15s ease',
                },
              }),
            ),
          )
        }

        function countRow() {
          var disabled = busy !== ''
          return h(
            'div',
            {
              key: 'chipCount',
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '12px 0',
                borderTop: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.08))',
              },
            },
            h(
              'div',
              { style: { flex: '1 1 auto', minWidth: 0 } },
              h('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-primary, #e8e8e8)' } }, '推荐条数'),
              h(
                'div',
                {
                  style: {
                    fontSize: '12px',
                    lineHeight: '18px',
                    marginTop: '2px',
                    color: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
                  },
                },
                '每轮回答结束后给几条候选（1–3）',
              ),
            ),
            h(
              'div',
              { style: { display: 'flex', gap: '6px', flex: '0 0 auto' } },
              [1, 2, 3].map(function (n) {
                var on = current.chipCount === n
                return h(
                  'button',
                  {
                    key: n,
                    type: 'button',
                    disabled: disabled,
                    onClick: function () {
                      save({ chipCount: n })
                    },
                    style: {
                      width: '30px',
                      height: '26px',
                      padding: 0,
                      fontSize: '13px',
                      cursor: disabled ? 'default' : 'pointer',
                      borderRadius: 'var(--dsw-radius-md, 8px)',
                      border:
                        '1px solid ' +
                        (on
                          ? 'var(--dsw-alias-state-business-primary, #4d8dff)'
                          : 'var(--dsw-alias-border-l1, rgba(255,255,255,.18))'),
                      background: on ? 'var(--dsw-alias-state-business-primary, #4d8dff)' : 'transparent',
                      color: on ? '#fff' : 'var(--dsw-alias-label-secondary, #b8b8b8)',
                    },
                  },
                  String(n),
                )
              }),
            ),
          )
        }

        if (React === null || info === null) {
          // 还没读到设置（或取不到 React）：占位，等 effect 回来
          return h(
            'div',
            { style: { padding: '16px', fontSize: '13px', color: 'var(--dsw-alias-label-tertiary, #8b8b8b)' } },
            error !== '' ? error : '正在读取设置…',
          )
        }

        return h(
          'div',
          { style: { padding: '4px 16px 20px', fontSize: '13px', color: 'var(--dsw-alias-label-primary, #e8e8e8)' } },
          h('div', { style: { padding: '12px 0 4px', fontSize: '15px', fontWeight: 600 } }, '输入预测'),
          h(
            'div',
            {
              style: {
                fontSize: '12px',
                lineHeight: '18px',
                color: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
              },
            },
            '根据当前对话和你平时说话的口吻，猜你下一条要发什么。灰字按 Tab 接受；推荐气泡点一下就直接发送。',
          ),
          switchRow('completionEnabled', '输入框灰字补全', '停顿约 0.3 秒后，在光标后给出灰色预测，按 Tab 接受'),
          switchRow('chipsEnabled', '回复后推荐', '每轮回答结束后，在输入框上方给几条可点击直接发送的候选'),
          current.chipsEnabled !== false ? countRow() : null,
          error !== ''
            ? h(
                'div',
                { style: { marginTop: '10px', fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #ff6b6b)' } },
                error,
              )
            : null,
          info.path !== undefined
            ? h(
                'div',
                {
                  style: {
                    marginTop: '12px',
                    fontSize: '11px',
                    lineHeight: '16px',
                    color: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
                    wordBreak: 'break-all',
                  },
                },
                '偏好保存在 ' + String(info.path) + '（改插件 patch 里的默认值不会覆盖这里的选择）',
              )
            : null,
        )
      }

      /**
       * 惰性注册「插件设置」里的标签页：slots 服务在 apply 时可能还没就绪，
       * 由 tick() 每秒试一次，命中一次就记住（最多 60 次）。
       */
      function tryRegisterSettingsTab() {
        if (slotDisposer !== null || slotTries > 60) return
        if (React === null || typeof ctx.get !== 'function') return
        var slots = null
        try {
          slots = ctx.get('slots')
        } catch (err) {
          slots = null
        }
        if (slots === null || slots === undefined || typeof slots.inject !== 'function') {
          slotTries += 1
          if (slotTries === 15) report('settings-tab', { ok: false, reason: 'slots unavailable' })
          return
        }
        try {
          slotDisposer = slots.inject('settings.plugins.tab', function () {
            return slots.register(
              {
                name: 'settings.plugins.tab',
                id: 'dsh-input-prediction',
                order: 20,
                label: function () {
                  return '输入预测'
                },
                inject: function () {
                  return {}
                },
              },
              SettingsTab,
            )
          })
          slotTries = 0
          log('settings tab registered')
          report('settings-tab', { ok: true })
        } catch (err) {
          slotTries += 1
          warn('settings tab registration failed', err)
          if (slotTries === 1) {
            report('settings-tab', { ok: false, reason: String((err && err.message) || err) })
          }
        }
      }

      /**
       * 官方槽 conversation.input.dock：composer 卡片正上方、卡片外、占布局。
       * 挂进官方槽就不会和同一位置的面板（genui / btw / 排队条）叠在一起；
       * 槽里的组件只给气泡提供一个挂载点，气泡本身仍是命令式 DOM。
       */
      function ChipsDock(props) {
        var h = React.createElement
        var ref = React.useRef(null)
        React.useEffect(
          function () {
            var host = ref.current
            if (host === null) return undefined
            chips.host = host
            var box = ensureChips()
            if (box.parentNode !== host) host.appendChild(box)
            renderChips()
            return function () {
              chips.host = null
              if (box.parentNode !== null) box.parentNode.removeChild(box)
              chips.container = null
            }
          },
          [props.sessionId],
        )
        return h('div', {
          ref: ref,
          style: {
            display: 'flex',
            justifyContent: 'flex-start',
            flexWrap: 'wrap',
            maxWidth: '100%',
            margin: '0 auto',
            paddingBottom: '4px',
          },
        })
      }

      /** 惰性注册气泡槽，同 tryRegisterSettingsTab。 */
      function tryRegisterChipsDock() {
        if (chipsDisposer !== null || chipsTries > 60) return
        if (React === null || typeof ctx.get !== 'function') return
        var slots = null
        try {
          slots = ctx.get('slots')
        } catch (err) {
          slots = null
        }
        if (slots === null || slots === undefined || typeof slots.inject !== 'function') {
          chipsTries += 1
          if (chipsTries === 15) report('chips-dock', { ok: false, reason: 'slots unavailable' })
          return
        }
        try {
          chipsDisposer = slots.inject('conversation.input.dock', function () {
            return slots.register(
              {
                name: 'conversation.input.dock',
                id: 'dsh-input-prediction-chips',
                order: 30,
                inject: function () {
                  return {}
                },
              },
              ChipsDock,
            )
          })
          chipsTries = 0
          log('chips dock registered')
          report('chips-dock', { ok: true })
        } catch (err) {
          chipsTries += 1
          warn('chips dock registration failed', err)
          if (chipsTries === 1) {
            report('chips-dock', { ok: false, reason: String((err && err.message) || err) })
          }
        }
      }

      /* ---------------------------------------------------------------- */
      /* 会话绑定 / 事件                                                    */
      function unbind() {
        if (unsubDraft !== null) {
          try {
            unsubDraft()
          } catch (_) {
            /* ignore */
          }
          unsubDraft = null
        }
        boundShell = null
        lastDraft = null
      }

      function bind(sessionId) {
        unbind()
        boundSessionId = sessionId
        if (typeof sessionId !== 'string' || sessionId === '') return false
        var scope = scopeOf(sessionId)
        if (scope === null) return false
        var shell = inputShell(scope)
        if (shell === null || shell.state === undefined || shell.state === null) return false
        if (typeof shell.state.subscribe !== 'function') return false
        boundShell = shell
        lastDraft = draftOf(shell)
        unsubDraft = shell.state.subscribe(function () {
          var draft = draftOf(shell)
          if (draft === lastDraft) return
          var wasEmpty = lastDraft === null || lastDraft === ''
          lastDraft = draft
          renderChips()
          if (state.suggestion !== '' && keyFor(boundSessionId, draft) !== state.key) {
            state.suggestion = ''
            hideGhost()
          }
          if (!wasEmpty && draft === '') {
            // 刚发出去：对话要往后走了，之前基于旧对话算出来的提示全部作废
            bumpContext()
            schedule(settings.settleMs)
            return
          }
          schedule(settings.debounceMs)
        })
        return true
      }

      function tick() {
        if (isStale()) {
          // 被新实例顶掉了：旧实例继续画只会和新实例打架
          if (typeof teardown === 'function') teardown()
          return
        }
        sweepForeignDom()
        tryRegisterSettingsTab()
        tryRegisterChipsDock()
        var sessionId = readCurrentSessionId()
        if (sessionId !== boundSessionId) {
          // 换了会话：上一个会话的灰字、候选、缓存一律作废，别带过来
          if (typeof sessionId === 'string' && sessionId !== '') bumpContext()
          if (bind(sessionId)) log('bound session', sessionId)
        }
        var nowRunning = turnRunning(sessionId)
        if (nowRunning) {
          // 回答进行中（含还在思考、正在跑工具）：灰字和候选都不该出现
          hideGhost()
          clearChips(true)
        } else if (!chipsBoot && boundShell !== null && draftOf(boundShell) === '') {
          // 页面刚打开、草稿空着：直接给上一轮回答配一批候选
          chipsBoot = true
          requestChips()
        }
        if (streaming !== nowRunning) {
          streaming = nowRunning
          // 回答开始 / 回答写完：对话上下文都变了，旧提示作废
          bumpContext()
          if (!nowRunning && boundShell !== null && draftOf(boundShell) === '') {
            schedule(260)
            // 回答写完了、草稿还空着 —— 猜下一条要问什么（建议气泡）
            requestChips()
          }
        }
        if (!completionOn()) return
        if (nowRunning) return
        // 会话切换/输入框重挂之后，兜底重新评估一次
        if (state.suggestion === '') schedule(settings.debounceMs)
      }

      function onSelectionChange() {
        render()
        if (state.suggestion === '') schedule(180)
      }

      function onLayout() {
        render()
        renderChips()
      }

      function onCompositionStart() {
        composing = true
        hideGhost()
      }

      function onCompositionEnd() {
        composing = false
        schedule(220)
      }

      /* ---------------------------------------------------------------- */
      /* 启动                                                              */
      fetch(HELLO_URL, { credentials: 'same-origin', cache: 'no-store' })
        .then(function (response) {
          return response.ok ? response.json() : null
        })
        .then(function (info) {
          if (info === null || typeof info !== 'object') return
          if (info.enabled === false) settings.enabled = false
          if (typeof info.maxSuggestionChars === 'number' && info.maxSuggestionChars > 0) {
            settings.maxSuggestionChars = info.maxSuggestionChars
          }
          if (info.completionEnabled !== undefined) settings.completionEnabled = info.completionEnabled !== false
          if (info.chipsEnabled !== undefined) settings.chipsEnabled = info.chipsEnabled !== false
          if (typeof info.chipCount === 'number' && info.chipCount > 0) {
            settings.chipCount = Math.max(1, Math.min(3, Math.round(info.chipCount)))
          }
          log('host hello', JSON.stringify(info))
          report('host-contact', {
            enabled: settings.enabled,
            completionEnabled: settings.completionEnabled,
            chipsEnabled: settings.chipsEnabled,
            chipCount: settings.chipCount,
            route: info.route,
          })
        })
        .catch(function () {
          /* 宿主路由不可达：保持默认，静默 */
          report('host-contact-failed', {})
        })

      document.addEventListener('keydown', onKeyDown, true)
      document.addEventListener('selectionchange', onSelectionChange, true)
      document.addEventListener('focusin', onSelectionChange, true)
      document.addEventListener('focusout', onSelectionChange, true)
      document.addEventListener('compositionstart', onCompositionStart, true)
      document.addEventListener('compositionend', onCompositionEnd, true)
      window.addEventListener('scroll', onLayout, true)
      window.addEventListener('resize', onLayout)

      // 客户端热重载会重新跑一次 apply()，但旧实例的 effect 清理不保证执行 —— 旧实例的
      // 浮层、气泡、计时器会留下来继续画（表现就是「改了没生效」「还是有重叠」）。
      // 新实例上任先占住 slot、扫掉旧 DOM，旧实例下次 tick 发现被顶掉就自己收摊。
      var token = {}
      try {
        window[INSTANCE_SLOT] = token
      } catch (_) {
        /* ignore */
      }
      sweepStaleDom()

      tickTimer = setInterval(tick, TICK_MS)
      tick()
      log('ready')
      report('ready', {
        version: VERSION,
        href: typeof location === 'undefined' ? '' : location.href,
        inject: exports.inject,
        sessionId: readCurrentSessionId(),
        turn: turnStatusProbe(),
      })

      function isStale() {
        try {
          return window[INSTANCE_SLOT] !== token
        } catch (_) {
          return false
        }
      }

      /** 把上一个实例留下的浮层/气泡 DOM 清掉，并把被它藏起来的占位文案放出来。 */
      function sweepStaleDom() {
        var stale = document.querySelectorAll('[' + LAYER_ATTR + '],[' + CHIPS_ATTR + ']')
        for (var i = 0; i < stale.length; i += 1) {
          if (stale[i].parentNode !== null) stale[i].parentNode.removeChild(stale[i])
        }
        var placeholder = document.querySelector('[' + HIDDEN_ATTR + ']')
        if (placeholder !== null) {
          placeholder.removeAttribute(HIDDEN_ATTR)
          placeholder.style.visibility = ''
        }
      }

      /**
       * 只在 tick 里跑：把「不是我的」浮层/气泡节点清掉。
       * 热重载遗留的旧实例会一直重建自己的浮层，这里是唯一能治它的地方（旧代码不知道被顶掉了）。
       */
      function sweepForeignDom() {
        var nodes = document.querySelectorAll('[' + LAYER_ATTR + ']')
        for (var i = 0; i < nodes.length; i += 1) {
          if (nodes[i] !== layer && nodes[i].parentNode !== null) {
            nodes[i].parentNode.removeChild(nodes[i])
          }
        }
        nodes = document.querySelectorAll('[' + CHIPS_ATTR + ']')
        for (var j = 0; j < nodes.length; j += 1) {
          var node = nodes[j]
          if (node === chips.container) continue
          if (layer !== null && layer.contains(node)) continue
          if (chips.host !== null && chips.host.contains(node)) continue
          if (node.parentNode !== null) node.parentNode.removeChild(node)
        }
      }

      function makeTeardown() {
        var done = false
        return function () {
          if (done) return
          done = true
            if (tickTimer !== null) clearInterval(tickTimer)
            if (timer !== null) clearTimeout(timer)
            abortInflight()
            if (chips.controller !== null) {
              try {
                chips.controller.abort()
              } catch (_) {
                /* ignore */
              }
              chips.controller = null
            }
            if (chips.container !== null && chips.container.isConnected) chips.container.remove()
            chips.container = null
            chips.host = null
            chips.items = []
            if (chipsDisposer !== null) {
              try {
                chipsDisposer()
              } catch (_) {
                /* ignore */
              }
              chipsDisposer = null
            }
            if (slotDisposer !== null) {
              try {
                slotDisposer()
              } catch (_) {
                /* ignore */
              }
              slotDisposer = null
            }
            unbind()
            document.removeEventListener('keydown', onKeyDown, true)
            document.removeEventListener('selectionchange', onSelectionChange, true)
            document.removeEventListener('focusin', onSelectionChange, true)
            document.removeEventListener('focusout', onSelectionChange, true)
            document.removeEventListener('compositionstart', onCompositionStart, true)
            document.removeEventListener('compositionend', onCompositionEnd, true)
            window.removeEventListener('scroll', onLayout, true)
            window.removeEventListener('resize', onLayout)
            setPlaceholderHidden(false)
            if (layer !== null && layer.isConnected) layer.remove()
            layer = null
            ghostEl = null
          }
      }
      var teardown = makeTeardown()
      if (typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return teardown
        })
      }
    }

    exports.name = 'dsh-input-prediction'
    exports.inject = ['sessions', 'uiSession', 'conversation']
    exports.apply = apply

    return module.exports
  },
})

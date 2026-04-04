/* Video Factory — 渲染进程 */

let session = null
let sessionData = {}
// 自动执行的步骤（默认：提取、改写、标题话题）
let autoSteps = { extract: true, rewrite: true, title: true, audio: false, video: false, edit: false }

// ── 初始化 ────────────────────────────────────────────────────────
async function init() {
  await newSession()
  await loadSessionList()
  bindAll()
  subscribeLog()
  checkEnv()
  loadBgmPresets()
  initSubOverlay()
  initCoverDesignModal()
}

// ── 环境检测 ─────────────────────────────────────────────────────
async function checkEnv() {
  const el = document.getElementById('env-status')
  try {
    const env = await window.api.envCheck()
    const parts = []

    const dot = (ok, label) =>
      `<span style="color:${ok ? '#0C0' : '#F66'};font-size:10px;margin-right:8px" title="${label}">${ok ? '●' : '○'}${label}</span>`

    if (env.ffmpeg) {
      parts.push(dot(env.ffmpeg.ok, env.ffmpeg.source === 'bundled' ? 'ffmpeg(内置)' : 'ffmpeg'))
    }
    if (env.python) {
      if (env.python.ok) {
        const verShort = env.python.version.replace('Python ', '')
        parts.push(dot(true, verShort))
        for (const [label, info] of Object.entries(env.pythonPackages || {})) {
          parts.push(dot(info.ok, label))
        }
      } else {
        parts.push(dot(false, 'Python'))
      }
    }

    el.innerHTML = parts.join('')
    el.title = JSON.stringify(env, null, 2)
  } catch (e) {
    el.innerHTML = '<span style="color:#F80">⚠ 检测失败</span>'
  }
}

// ── 日志 ─────────────────────────────────────────────────────────
function subscribeLog() {
  window.api.onLog(msg => {
    const body = document.getElementById('log-body')
    const line = document.createElement('div')
    const isError = msg.type === 'error' ||
      (msg.message && /error|failed|exception|traceback/i.test(msg.message) && msg.message.length > 100)
    line.className = 'log-line' + (isError ? ' error' : msg.type === 'done' ? ' done' : '')
    line.textContent = msg.message || ''
    body.appendChild(line)
    body.scrollTop = body.scrollHeight
    if (isError) {
      setStatus('出错: ' + (msg.message || '').slice(0, 60))
    }
  })
}

function setStatus(txt) {
  document.getElementById('status-text').textContent = txt
}

// ── Session ───────────────────────────────────────────────────────
async function newSession() {
  session = await window.api.sessionCreate()
  sessionData = {}
  clearGenStatus()
  // 清空所有输入框，避免旧 session 数据残留
  document.getElementById('bgm-path').value = ''
  document.getElementById('audio-file-path').value = ''
  document.getElementById('video-file-path').value = ''
  document.getElementById('cover-path').value = ''
  document.getElementById('cover-tabs').style.display = 'none'
}

async function loadSession(id) {
  const list = await window.api.sessionList()
  const found = list.find(x => x.id === id)
  if (!found) return
  // 从当前 session 路径推断 sessions 根目录
  const sessionsRoot = session.dir.replace(/[\\\/]\d+[\\\/]?$/, '')
  const dir = sessionsRoot + '\\' + id
  const sessionPath = dir + '\\session.json'
  session = { id, dir, sessionPath }
  sessionData = found.data || {}
  clearGenStatus()
  // 切换 session 时清理画中画状态，避免 segIndices 对不上新的 segments
  if (sessionData.pipSegments) {
    const maxIdx = sessionData.pipSegments.length - 1
    sessionData.pipGroups = (sessionData.pipGroups || []).filter(g =>
      Array.isArray(g.segIndices) && g.segIndices.every(i => i >= 0 && i <= maxIdx)
    )
  } else {
    sessionData.pipGroups = []
  }
  // 清空输入框避免旧数据残留
  document.getElementById('bgm-path').value = ''
  document.getElementById('audio-file-path').value = ''
  document.getElementById('video-file-path').value = ''
  document.getElementById('cover-path').value = ''
  document.getElementById('cover-tabs').style.display = 'none'
  refreshUI()
}

async function save(updates) {
  Object.assign(sessionData, updates)
  await window.api.sessionWrite(session.sessionPath, sessionData)
}

async function loadSessionList() {
  // no-op, history is loaded on demand via openHistory
}

// ── 历史任务面板 ─────────────────────────────────────────────────
async function openHistory() {
  const list = await window.api.sessionList()
  const container = document.getElementById('history-list')

  if (list.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:var(--text2);padding:20px">暂无历史任务</div>'
  } else {
    container.innerHTML = list.map(({ id, data }) => {
      const name = data.name || data.url || `任务 ${id.slice(-6)}`
      const date = data.createdAt ? new Date(data.createdAt).toLocaleString('zh-CN') : ''
      return `<div class="history-item" data-id="${id}">
        <div class="history-main">
          <span class="history-name" title="${name}">${name}</span>
          <span class="history-date">${date}</span>
        </div>
        <div class="history-actions">
          <button class="btn-small history-btn-load" data-id="${id}" title="加载">打开</button>
          <button class="btn-small history-btn-rename" data-id="${id}" title="重命名">改名</button>
          <button class="btn-small history-btn-delete" data-id="${id}" title="删除" style="color:#F66">删除</button>
        </div>
      </div>`
    }).join('')
  }

  // 事件委托
  container.onclick = async e => {
    const loadBtn = e.target.closest('.history-btn-load')
    const renameBtn = e.target.closest('.history-btn-rename')
    const deleteBtn = e.target.closest('.history-btn-delete')

    if (loadBtn) {
      await loadSession(loadBtn.dataset.id)
      document.getElementById('history-modal').style.display = 'none'
    }
    if (renameBtn) {
      const id = renameBtn.dataset.id
      const item = list.find(x => x.id === id)
      const oldName = item?.data?.name || item?.data?.url || `任务 ${id.slice(-6)}`
      const newName = prompt('请输入任务名称：', oldName)
      if (newName && newName.trim()) {
        await window.api.sessionRename(id, newName.trim())
        // 如果是当前 session，同步更新
        if (session && session.id === id) {
          sessionData.name = newName.trim()
        }
        await openHistory()
      }
    }
    if (deleteBtn) {
      const id = deleteBtn.dataset.id
      if (!confirm('确定删除此任务？删除后不可恢复。')) return
      await window.api.sessionDelete(id)
      await openHistory()
    }
  }

  document.getElementById('history-modal').style.display = 'flex'
}

// ── 绑定所有事件 ───────────────────────────────────────────────────
function bindAll() {
  // 标题栏
  document.getElementById('btn-new-session').onclick = async () => { await newSession(); await loadSessionList() }
  document.getElementById('btn-history').onclick = openHistory

  // 自动步骤面板
  const toggle = document.getElementById('auto-steps-toggle')
  const panel = document.getElementById('auto-steps-panel')
  toggle.onclick = () => {
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none'
  }
  panel.querySelectorAll('input').forEach(cb => {
    cb.onchange = () => {
      autoSteps[cb.dataset.step] = cb.checked
    }
    // 同步初始状态
    cb.checked = autoSteps[cb.dataset.step]
  })

  // 设置
  document.getElementById('btn-settings').onclick = openSettings
  document.getElementById('btn-close-settings').onclick = () => { document.getElementById('settings-modal').style.display = 'none' }
  document.getElementById('btn-save-settings').onclick = saveSettings
  document.getElementById('settings-modal').onclick = e => { if (e.target.id === 'settings-modal') e.target.style.display = 'none' }

  // 提示词编辑
  document.getElementById('btn-prompt-edit').onclick = openPromptModal
  document.getElementById('btn-close-prompt').onclick = () => { document.getElementById('prompt-modal').style.display = 'none' }
  document.getElementById('btn-save-prompt').onclick = savePrompt
  document.getElementById('btn-reset-prompt').onclick = () => { document.getElementById('prompt-textarea').value = DEFAULT_REWRITE_PROMPT }
  document.getElementById('prompt-modal').onclick = e => { if (e.target.id === 'prompt-modal') e.target.style.display = 'none' }

  // 历史弹窗
  document.getElementById('btn-close-history').onclick = () => { document.getElementById('history-modal').style.display = 'none' }
  document.getElementById('history-modal').onclick = e => { if (e.target.id === 'history-modal') e.target.style.display = 'none' }

  // 日志抽屉
  document.getElementById('log-toggle').onclick = () => {
    const d = document.getElementById('log-drawer')
    d.classList.toggle('open')
    document.getElementById('log-toggle').textContent = d.classList.contains('open') ? '▼ 日志' : '▲ 日志'
  }

  // 语速显示
  document.getElementById('speed-slider').oninput = e => {
    document.getElementById('speed-val').textContent = parseFloat(e.target.value).toFixed(1)
  }
  document.getElementById('voice-vol').oninput = e => {
    document.getElementById('voice-vol-val').textContent = Math.round(e.target.value * 100) + '%'
  }
  document.getElementById('bgm-vol').oninput = e => {
    document.getElementById('bgm-vol-val').textContent = Math.round(e.target.value * 100) + '%'
  }

  // 字幕开关
  document.getElementById('subtitle-enable').onchange = e => {
    document.getElementById('subtitle-options').style.display = e.target.checked ? '' : 'none'
    updateSubOverlay()
  }

  // 字幕样式变化时实时更新预览
  ;['sub-color', 'sub-stroke', 'sub-size', 'sub-font', 'sub-shadow-color', 'sub-shadow-opacity', 'sub-shadow-angle', 'sub-shadow-dist', 'sub-stroke-enable', 'sub-shadow-enable'].forEach(id => {
    document.getElementById(id).addEventListener('input', updateSubOverlay)
    document.getElementById(id).addEventListener('change', updateSubOverlay)
  })
  document.getElementById('sub-shadow-opacity').addEventListener('input', e => {
    document.getElementById('sub-shadow-opacity-val').textContent = e.target.value + '%'
  })
  document.getElementById('sub-shadow-angle').addEventListener('input', e => {
    document.getElementById('sub-shadow-angle-val').textContent = e.target.value + '°'
  })
  // 阴影开关控制详细行显示
  document.getElementById('sub-shadow-enable').addEventListener('change', e => {
    document.getElementById('sub-shadow-detail-row').style.display = e.target.checked ? '' : 'none'
  })

  // 步骤按钮
  document.getElementById('btn-extract').onclick = runExtract
  document.getElementById('btn-rewrite').onclick = runRewrite
  document.getElementById('btn-title').onclick = runTitle
  document.getElementById('btn-audio').onclick = runAudio
  document.getElementById('btn-video').onclick = runVideo
  document.getElementById('btn-cancel-video').onclick = () => window.api.cancelStep('video')
  document.getElementById('btn-edit').onclick = runEdit
  document.getElementById('btn-publish').onclick = runPublish
  document.getElementById('btn-gen-subtitle').onclick = runSubtitle
  // 封面生成
  document.getElementById('btn-design-cover').onclick = openCoverDesignModal
  document.getElementById('btn-pick-cover').onclick = async () => {
    const p = await window.api.openFile({
      title: '选择封面图片',
      filters: [{ name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
    })
    if (p) {
      document.getElementById('cover-path').value = p
      showCoverPreview(p)
      document.getElementById('cover-tabs').style.display = 'none'
    }
  }

  // 封面平台 tab 切换
  document.getElementById('cover-tabs').addEventListener('click', e => {
    const tab = e.target.closest('.cover-tab')
    if (!tab) return
    document.querySelectorAll('.cover-tab').forEach(t => t.classList.remove('active'))
    tab.classList.add('active')
    const platform = tab.dataset.platform
    const coverPath = sessionData.cover?.[platform] || sessionData.cover?.path || ''
    if (coverPath) {
      document.getElementById('cover-path').value = coverPath
      showCoverPreview(coverPath)
    }
  })

  // 获取图片 - 打开当前封面本地路径
  document.getElementById('btn-open-cover').onclick = () => {
    const activeTab = document.querySelector('.cover-tab.active')
    const platform = activeTab?.dataset?.platform || 'douyin'
    const coverPath = sessionData.cover?.[platform] || sessionData.cover?.path || ''
    if (coverPath) {
      const folder = coverPath.substring(0, coverPath.lastIndexOf('\\')) || coverPath.substring(0, coverPath.lastIndexOf('/'))
      window.api.showItemInFolder(coverPath)
    } else {
      alert('请先生成封面')
    }
  }

  // 复制标题+话题
  document.getElementById('btn-copy-title').onclick = async () => {
    const title = sessionData.title?.title || ''
    const hashtags = sessionData.title?.hashtags || []
    if (!title) { alert('无标题内容'); return }
    const text = title + (hashtags.length > 0 ? '\n' + hashtags.slice(0, 5).map(t => `#${t}`).join(' ') : '')
    await navigator.clipboard.writeText(text)
    setStatus('标题+话题已复制')
    setTimeout(() => setStatus('就绪'), 2000)
  }

  document.getElementById('btn-pip-compose').onclick = () => runPipCompose()
  document.getElementById('btn-open-output-folder').onclick = async () => {
    const p = sessionData.edit?.output_path
    if (p) await window.api.showItemInFolder(p)
  }

  document.getElementById('btn-restore-original').onclick = async () => {
    if (!confirm('确定还原到原始视频（去除画中画效果）？')) return
    sessionData.edit = { ...sessionData.edit, output_path: '' }
    await save({ edit: sessionData.edit })
    const originalPath = sessionData.video?.video_path
    if (originalPath) updateVideoPreview(originalPath)
    document.getElementById('btn-restore-original').style.display = 'none'
    clearGenStatus()
  }

  let _previewUIVisible = true
  document.getElementById('btn-toggle-preview-ui').onclick = () => {
    _previewUIVisible = !_previewUIVisible
    const guide = document.getElementById('sub-guide')
    const overlay = document.getElementById('sub-overlay')
    guide.style.display = _previewUIVisible ? '' : 'none'
    if (overlay.style.display !== 'none') overlay.style.visibility = _previewUIVisible ? '' : 'hidden'
    document.getElementById('btn-toggle-preview-ui').textContent = _previewUIVisible ? '隐藏字幕参考线' : '显示字幕参考线'
  }

  // 背景音乐选择
  document.getElementById('btn-pick-bgm').onclick = async () => {
    const p = await window.api.openFile({
      title: '选择背景音乐',
      filters: [{ name: '音频文件', extensions: ['mp3', 'wav', 'm4a', 'aac'] }]
    })
    if (p) {
      document.getElementById('bgm-path').value = p
      document.getElementById('bgm-preset').value = ''
      document.getElementById('bgm-custom-row').style.display = 'flex'
    }
  }
  document.getElementById('btn-clear-bgm').onclick = () => {
    document.getElementById('bgm-path').value = ''
    document.getElementById('bgm-custom-row').style.display = 'none'
  }
  document.getElementById('bgm-preset').onchange = e => {
    const val = e.target.value
    if (val) {
      document.getElementById('bgm-path').value = val
      document.getElementById('bgm-custom-row').style.display = 'none'
    } else {
      document.getElementById('bgm-path').value = ''
    }
  }

  // 音频/视频文件选择
  document.getElementById('btn-pick-audio').onclick = async () => {
    const p = await window.api.openFile({
      title: '选择音频文件',
      filters: [{ name: '音频文件', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] }]
    })
    if (p) document.getElementById('audio-file-path').value = p
  }
  document.getElementById('btn-pick-video').onclick = async () => {
    const p = await window.api.openFile({
      title: '选择视频文件',
      filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm'] }]
    })
    if (p) {
      document.getElementById('video-file-path').value = p
      await save({ video: { video_path: p, status: 'done' } })
      refreshUI()
    }
  }

  // (cover-path is now hidden, manual pick handled by btn-pick-cover)

  // 画中画列表事件委托
  let _editingGroupIdx = null
  document.getElementById('pip-list').addEventListener('click', async e => {
    const composeBtn = e.target.closest('.pip-btn-compose-group')
    const removeBtn = e.target.closest('.pip-btn-remove-group')
    const editBtn = e.target.closest('.pip-btn-edit-group')
    if (composeBtn) {
      const gIdx = parseInt(composeBtn.dataset.gidx)
      await runPipCompose(gIdx)
    }
    if (removeBtn) {
      const gIdx = parseInt(removeBtn.dataset.gidx)
      const groups = sessionData.pipGroups || []
      groups.splice(gIdx, 1)
      await save({ pipGroups: groups })
      renderPipList()
    }
    if (editBtn) {
      const gIdx = parseInt(editBtn.dataset.gidx)
      const groups = sessionData.pipGroups || []
      const g = groups[gIdx]
      if (!g) return
      _editingGroupIdx = gIdx
      _pendingPip = { ...g }
      // fill modal fields
      document.getElementById('pip-confirm-range').textContent = `${srtTimeToShort(g.start)} - ${srtTimeToShort(g.end)}`
      document.getElementById('pip-confirm-dur').textContent = ''
      document.getElementById('pip-confirm-video').textContent = g.videoPath.split(/[/\\]/).pop()
      document.getElementById('pip-confirm-cover-bgm').checked = !!g.coverBgm
      document.getElementById('pip-confirm-x').value = g.x ?? 0
      document.getElementById('pip-confirm-y').value = g.y ?? 0
      document.getElementById('pip-confirm-w').value = g.w ?? 100
      document.getElementById('pip-confirm-h').value = g.h ?? 100
      document.getElementById('pip-crop-top').value = g.cropTop ?? 0
      document.getElementById('pip-crop-bottom').value = g.cropBottom ?? 0
      document.getElementById('pip-crop-left').value = g.cropLeft ?? 0
      document.getElementById('pip-crop-right').value = g.cropRight ?? 0
      document.getElementById('btn-confirm-pip-modal').textContent = '保存修改'
      document.getElementById('pip-confirm-modal').style.display = 'flex'
      const startSec = srtToSec(g.start)
      const endSec = srtToSec(g.end)
      requestAnimationFrame(() => requestAnimationFrame(() => {
        initPipPosCanvas(g.videoPath, startSec)
        const mainVideo = document.querySelector('#video-preview video')
        const totalDur = mainVideo ? mainVideo.duration : (endSec + 10)
        _mainTimeline = initMainTimeline(totalDur, startSec, endSec)
        _srcTimeline = initSrcTimeline(g.videoPath, g.srcStart ?? null, g.srcEnd ?? null, endSec - startSec)
      }))
    }
  })

  // 时间格式辅助：秒 -> 00:00:10,000
  function secToSrt(sec) {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = Math.floor(sec % 60)
    const ms = Math.round((sec % 1) * 1000)
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`
  }
  // SRT时间 -> 秒
  function srtToSec(srt) {
    const m = srt.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/)
    if (!m) return 0
    return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 1000
  }
  function secToSrtTime(sec) {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = Math.floor(sec % 60)
    const ms = Math.round((sec % 1) * 1000)
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`
  }

  // 「为选中段选择视频」按钮
  let _pendingPip = null  // 待确认的画中画片段
  document.getElementById('pip-pick-selected').addEventListener('click', async () => {
    const checkboxes = document.querySelectorAll('.pip-seg-check:checked')
    if (checkboxes.length === 0) return alert('请先勾选要替换的字幕段')

    const indices = Array.from(checkboxes).map(cb => parseInt(cb.dataset.idx)).sort((a, b) => a - b)
    for (let i = 1; i < indices.length; i++) {
      if (indices[i] !== indices[i - 1] + 1) return alert('请选择连续的字幕段')
    }

    const segments = sessionData.pipSegments || []
    const firstSeg = segments[indices[0]]
    const lastSeg = segments[indices[indices.length - 1]]
    const mergedText = indices.map(i => segments[i].text).join('')

    // 计算字幕段时长
    const dur = srtToSec(lastSeg.end) - srtToSec(firstSeg.start)
    const durDisplay = dur.toFixed(1) + '秒'

    const p = await window.api.openFile({
      title: '选择替换视频或图片',
      filters: [
        { name: '视频/图片文件', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'jpg', 'jpeg', 'png', 'gif', 'webp'] }
      ]
    })
    if (!p) return

    // 弹出确认框
    _pendingPip = {
      start: firstSeg.start,
      end: lastSeg.end,
      text: mergedText,
      segIndices: indices,
      videoPath: p,
      dur: parseFloat(dur.toFixed(1))
    }
    document.getElementById('pip-confirm-range').textContent = `${srtTimeToShort(firstSeg.start)} - ${srtTimeToShort(lastSeg.end)}`
    document.getElementById('pip-confirm-dur').textContent = `时长: ${durDisplay}`
    document.getElementById('pip-confirm-video').textContent = p.split(/[/\\]/).pop()
    document.getElementById('pip-confirm-cover-bgm').checked = false
    // 重置位置
    document.getElementById('pip-confirm-x').value = 5
    document.getElementById('pip-confirm-y').value = 5
    document.getElementById('pip-confirm-w').value = 90
    document.getElementById('pip-confirm-h').value = 90
    // 重置裁剪
    document.getElementById('pip-crop-top').value = 0
    document.getElementById('pip-crop-bottom').value = 0
    document.getElementById('pip-crop-left').value = 0
    document.getElementById('pip-crop-right').value = 0
    document.getElementById('pip-confirm-modal').style.display = 'flex'
    document.getElementById('btn-confirm-pip-modal').textContent = '确认添加'
    _editingGroupIdx = null
    const startSec = srtToSec(firstSeg.start)
    const endSec = srtToSec(lastSeg.end)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      initPipPosCanvas(p, startSec)
      const mainVideo = document.querySelector('#video-preview video')
      const totalDur = (mainVideo && isFinite(mainVideo.duration)) ? mainVideo.duration : (endSec + 10)
      _mainTimeline = initMainTimeline(totalDur, startSec, endSec)
      _srcTimeline = initSrcTimeline(p, null, null, endSec - startSec)
    }))
  })

  // 确认弹窗事件
  function closePipModal() {
    document.getElementById('pip-confirm-modal').style.display = 'none'
    document.getElementById('btn-confirm-pip-modal').textContent = '确认添加'
    _editingGroupIdx = null
    if (_srcTimeline?.destroy) _srcTimeline.destroy()
  }
  document.getElementById('btn-close-pip-modal').onclick = closePipModal
  document.getElementById('btn-cancel-pip-modal').onclick = closePipModal
  document.getElementById('pip-confirm-modal').onclick = e => { if (e.target.id === 'pip-confirm-modal') closePipModal() }

  // 等比锁定（始终开启，无 UI 按钮）
  window._pipRatioLocked = true
  const wInput = document.getElementById('pip-confirm-w')
  const hInput = document.getElementById('pip-confirm-h')
  wInput.addEventListener('input', () => { if (window._pipRatioLocked) hInput.value = wInput.value })
  hInput.addEventListener('input', () => { if (window._pipRatioLocked) wInput.value = hInput.value })

  // ── 主视频时间进度条 ──────────────────────────────────────────────
  function initMainTimeline(totalDur, initStart, initEnd) {
    const bar = document.getElementById('pip-main-timeline')
    const rangeEl = document.getElementById('pip-main-range')
    const hs = document.getElementById('pip-main-handle-start')
    const he = document.getElementById('pip-main-handle-end')
    const label = document.getElementById('pip-main-time-label')
    let pctS = initStart / totalDur, pctE = initEnd / totalDur

    function render() {
      const bw = bar.offsetWidth
      if (!bw) return
      hs.style.left = (pctS * bw) + 'px'
      he.style.left = (pctE * bw) + 'px'
      rangeEl.style.left = (pctS * bw) + 'px'
      rangeEl.style.width = ((pctE - pctS) * bw) + 'px'
      const fmt = s => { const m = Math.floor(s/60), sec = Math.floor(s%60); return `${m}:${String(sec).padStart(2,'0')}` }
      label.textContent = `${fmt(pctS*totalDur)} → ${fmt(pctE*totalDur)}`
    }
    requestAnimationFrame(render)

    function dragHandle(handle, isStart) {
      handle.addEventListener('mousedown', e => {
        e.preventDefault(); e.stopPropagation()
        const bw = bar.offsetWidth, bx = bar.getBoundingClientRect().left
        const onMove = ev => {
          let p = Math.max(0, Math.min(1, (ev.clientX - bx) / bw))
          if (isStart) pctS = Math.min(p, pctE - 0.01)
          else pctE = Math.max(p, pctS + 0.01)
          render()
        }
        const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
      })
    }
    dragHandle(hs, true); dragHandle(he, false)
    return {
      getStart: () => pctS * totalDur,
      getEnd: () => pctE * totalDur,
      // 保持起点不变，把终点设为 起点+时长
      setDuration: (dur) => {
        if (!totalDur || !isFinite(dur)) return
        const newEnd = Math.min(1, pctS + dur / totalDur)
        pctE = Math.max(newEnd, pctS + 0.01)
        render()
      }
    }
  }

  // ── 素材时间进度条 ────────────────────────────────────────────────
  function initSrcTimeline(filePath, initSrcStart, initSrcEnd, segDur) {
    const bar = document.getElementById('pip-src-timeline')
    const rangeEl = document.getElementById('pip-src-range')
    const hs = document.getElementById('pip-src-handle-start')
    const he = document.getElementById('pip-src-handle-end')
    const label = document.getElementById('pip-src-time-label')
    const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(filePath)

    // 使用独立的素材预览 video 元素
    const player = document.getElementById('pip-src-video')
    const videoWrap = document.getElementById('pip-src-video-wrap')
    const playBtn = document.getElementById('pip-src-play-btn')
    const progressBar = document.getElementById('pip-src-progress-bar')
    const progressFill = document.getElementById('pip-src-progress-fill')
    const progressRange = document.getElementById('pip-src-progress-range')
    const timeDisplay = document.getElementById('pip-src-time-display')
    const btnSetStart = document.getElementById('pip-src-set-start')
    const btnSetEnd = document.getElementById('pip-src-set-end')
    const durRow = document.getElementById('pip-src-dur-row')
    const durDisplay = document.getElementById('pip-src-dur-display')

    if (isImage) {
      label.textContent = '图片素材，无需裁剪时间'
      document.getElementById('pip-src-time-label-row').style.display = 'none'
      bar.style.display = 'none'
      videoWrap.style.display = 'none'
      durRow.style.display = 'none'
      return { getSrcStart: () => 0, getSrcEnd: () => null }
    }

    document.getElementById('pip-src-time-label-row').style.display = ''
    bar.style.display = ''
    videoWrap.style.display = 'flex'
    label.textContent = '加载中...'
    let pctS = 0, pctE = 1, totalDur = 0

    player.src = filePath
    player.load()

    const fmt = s => { const m = Math.floor(s/60), sec = Math.floor(s%60); return `${m}:${String(sec).padStart(2,'0')}` }

    // 同步素材选中时长到主时间轴终点（方案B：手动调整后才同步）
    function syncDurToMainTimeline() {
      if (!totalDur || !_mainTimeline || !userAdjusted) return
      const selDur = (pctE - pctS) * totalDur
      durDisplay.textContent = fmt(selDur)
      durRow.style.display = ''
      _mainTimeline.setDuration(selDur)
    }

    function renderTimeline() {
      if (!totalDur) return
      const bw = bar.offsetWidth
      hs.style.left = (pctS * bw) + 'px'
      he.style.left = (pctE * bw) + 'px'
      rangeEl.style.left = (pctS * bw) + 'px'
      rangeEl.style.width = ((pctE - pctS) * bw) + 'px'
      label.textContent = `${fmt(pctS*totalDur)} → ${fmt(pctE*totalDur)}`
      progressRange.style.left = (pctS * 100) + '%'
      progressRange.style.width = ((pctE - pctS) * 100) + '%'
      syncDurToMainTimeline()
    }

    function renderProgress() {
      if (!totalDur) return
      const pct = player.currentTime / totalDur
      progressFill.style.width = (pct * 100) + '%'
      timeDisplay.textContent = fmt(player.currentTime) + ' / ' + fmt(totalDur)
    }

    let userAdjusted = false  // 用户是否手动调整过

    player.addEventListener('loadedmetadata', () => {
      totalDur = player.duration
      if (initSrcStart != null) {
        // 编辑已有条目：恢复保存的值
        pctS = Math.max(0, initSrcStart / totalDur)
        pctE = initSrcEnd != null ? Math.min(1, initSrcEnd / totalDur) : 1
        userAdjusted = true
      } else {
        // 新添加：方案A，srcEnd = srcStart + 字幕段时长
        pctS = 0
        if (segDur && segDur < totalDur) {
          pctE = segDur / totalDur
        } else {
          pctE = 1
        }
      }
      renderTimeline()
      renderProgress()
    })
    player.addEventListener('timeupdate', renderProgress)
    player.addEventListener('ended', () => { playBtn.textContent = '▶' })

    playBtn.onclick = () => {
      if (player.paused) { player.play(); playBtn.textContent = '⏸' }
      else { player.pause(); playBtn.textContent = '▶' }
    }

    progressBar.addEventListener('click', e => {
      if (!totalDur) return
      const rect = progressBar.getBoundingClientRect()
      const p = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      player.currentTime = p * totalDur
    })

    btnSetStart.onclick = () => {
      if (!totalDur) return
      pctS = Math.min(player.currentTime / totalDur, pctE - 0.01)
      userAdjusted = true
      renderTimeline()
    }
    btnSetEnd.onclick = () => {
      if (!totalDur) return
      pctE = Math.max(player.currentTime / totalDur, pctS + 0.01)
      userAdjusted = true
      renderTimeline()
    }

    function dragHandle(handle, isStart) {
      handle.addEventListener('mousedown', e => {
        e.preventDefault(); e.stopPropagation()
        const bw = bar.offsetWidth, bx = bar.getBoundingClientRect().left
        const onMove = ev => {
          let p = Math.max(0, Math.min(1, (ev.clientX - bx) / bw))
          if (isStart) pctS = Math.min(p, pctE - 0.01)
          else pctE = Math.max(p, pctS + 0.01)
          userAdjusted = true
          renderTimeline()
          if (totalDur) player.currentTime = (isStart ? pctS : pctE) * totalDur
        }
        const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
      })
    }
    dragHandle(hs, true); dragHandle(he, false)
    return {
      getSrcStart: () => pctS * totalDur,
      getSrcEnd:   () => pctE * totalDur,
      destroy: () => { player.pause(); player.src = ''; playBtn.textContent = '▶'; durRow.style.display = 'none' }
    }
  }

  let _mainTimeline = null, _srcTimeline = null

  document.getElementById('btn-confirm-pip-modal').onclick = async () => {
    if (!_pendingPip) return
    const coverBgm = document.getElementById('pip-confirm-cover-bgm').checked
    const mainVideo = document.querySelector('#video-preview video')
    const totalDur = (mainVideo && isFinite(mainVideo.duration)) ? mainVideo.duration : 0
    let start = _pendingPip.start, end = _pendingPip.end
    if (_mainTimeline && totalDur) {
      const s = _mainTimeline.getStart()
      const e2 = _mainTimeline.getEnd()
      if (isFinite(s) && isFinite(e2)) {
        start = secToSrtTime(s)
        end   = secToSrtTime(e2)
      }
    }
    let srcStart = 0, srcEnd = null
    if (_srcTimeline) {
      srcStart = _srcTimeline.getSrcStart()
      srcEnd   = _srcTimeline.getSrcEnd()
    }
    const x = parseFloat(document.getElementById('pip-confirm-x').value) || 0
    const y = parseFloat(document.getElementById('pip-confirm-y').value) || 0
    const w = Math.max(5, parseFloat(document.getElementById('pip-confirm-w').value) || 100)
    const h = Math.max(5, parseFloat(document.getElementById('pip-confirm-h').value) || 100)
    const cropTop    = parseFloat(document.getElementById('pip-crop-top').value) || 0
    const cropBottom = parseFloat(document.getElementById('pip-crop-bottom').value) || 0
    const cropLeft   = parseFloat(document.getElementById('pip-crop-left').value) || 0
    const cropRight  = parseFloat(document.getElementById('pip-crop-right').value) || 0
    const groups = sessionData.pipGroups || []
    const entry = { ..._pendingPip, start, end, coverBgm, x, y, w, h, cropTop, cropBottom, cropLeft, cropRight, srcStart, srcEnd }
    if (_editingGroupIdx !== null) {
      groups[_editingGroupIdx] = entry
    } else {
      groups.push(entry)
    }
    await save({ pipGroups: groups })
    _pendingPip = null
    closePipModal()
    renderPipList()
  }

  document.getElementById('extract-text').onblur = () => {
    save({ extract: { ...sessionData.extract, raw_transcript: document.getElementById('extract-text').value } })
  }
  document.getElementById('rewrite-text').onblur = () => {
    save({ rewrite: { ...sessionData.rewrite, rewritten: document.getElementById('rewrite-text').value } })
  }
  document.getElementById('title-input').onblur = () => {
    save({ title: { ...sessionData.title, title: document.getElementById('title-input').value } })
  }

  // 标签
  document.getElementById('tag-container').addEventListener('click', e => {
    const btn = e.target.closest('.tag-remove')
    if (!btn) return
    const tag = btn.dataset.tag
    const tags = (sessionData.title?.hashtags || []).filter(t => t !== tag)
    save({ title: { ...sessionData.title, hashtags: tags } })
    renderTags(tags)
  })

  // 音频播放
  const playBtn = document.getElementById('btn-play-audio')
  const audioEl = document.getElementById('audio-el')
  playBtn.onclick = () => {
    if (audioEl.paused) { audioEl.play(); playBtn.textContent = '⏸' }
    else { audioEl.pause(); playBtn.textContent = '▶' }
  }
  audioEl.onended = () => { playBtn.textContent = '▶' }
}

// ── 刷新 UI ───────────────────────────────────────────────────────
function refreshUI() {
  // 文案
  document.getElementById('url-input').value = sessionData.url || ''
  document.getElementById('extract-text').value = sessionData.extract?.raw_transcript || ''
  document.getElementById('rewrite-text').value = sessionData.rewrite?.rewritten || ''
  document.getElementById('title-input').value = sessionData.title?.title || ''
  renderTags(sessionData.title?.hashtags || [])

  // 音频
  const audioPath = sessionData.audio?.audio_path || ''
  if (audioPath) {
    document.getElementById('audio-file-row').style.display = 'flex'
    document.getElementById('audio-filename').textContent = audioPath.split(/[/\\]/).pop()
    document.getElementById('audio-el').src = 'file:///' + audioPath.replace(/\\/g, '/')
    if (!document.getElementById('audio-file-path').value) {
      document.getElementById('audio-file-path').value = audioPath
    }
  } else {
    document.getElementById('audio-file-row').style.display = 'none'
  }

  // 视频（优先显示合成后的最终视频）
  const videoPath = sessionData.edit?.output_path || sessionData.video?.video_path || ''
  if (videoPath) {
    document.getElementById('video-file-row').style.display = 'flex'
    document.getElementById('video-filename').textContent = videoPath.split(/[/\\]/).pop()
    updateVideoPreview(videoPath)
    // 如果显示的是合成后的视频，显示还原按钮
    const isEdited = !!sessionData.edit?.output_path
    document.getElementById('btn-restore-original').style.display = isEdited ? '' : 'none'
    if (!document.getElementById('video-file-path').value) {
      document.getElementById('video-file-path').value = videoPath
    }
  } else {
    document.getElementById('video-file-row').style.display = 'none'
  }

  // 字幕
  const srtPath = sessionData.subtitle?.srt_path || ''
  if (srtPath) {
    document.getElementById('srt-file-row').style.display = 'flex'
    document.getElementById('srt-filename').textContent = srtPath.split(/[/\\]/).pop()
  }

  // 封面
  const coverDesign = sessionData.cover?.design || {}
  const hasPlatformCovers = sessionData.cover?.douyin
  if (hasPlatformCovers) {
    document.getElementById('cover-tabs').style.display = 'flex'
    const activeTab = document.querySelector('.cover-tab.active')
    const platform = activeTab?.dataset?.platform || 'douyin'
    const coverPath = sessionData.cover[platform] || sessionData.cover.path || ''
    if (coverPath) {
      document.getElementById('cover-path').value = coverPath
      showCoverPreview(coverPath)
    }
    document.getElementById('btn-open-cover').style.display = ''
  } else {
    const coverPath = sessionData.cover?.path || ''
    if (coverPath) {
      document.getElementById('cover-path').value = coverPath
      showCoverPreview(coverPath)
      document.getElementById('btn-open-cover').style.display = ''
    }
    document.getElementById('cover-tabs').style.display = 'none'
    document.getElementById('btn-open-cover').style.display = 'none'
  }

  // 画中画
  renderPipList()

  // 字幕 overlay 位置恢复
  const savedMarginV = sessionData.editConfig?.subMarginV
  if (savedMarginV !== undefined) {
    subMarginPct = (savedMarginV / 288) * 100
  }
  // 字幕样式恢复
  const ec = sessionData.editConfig || {}
  if (ec.subColor) document.getElementById('sub-color').value = ec.subColor
  if (ec.subStroke) document.getElementById('sub-stroke').value = ec.subStroke
  if (ec.subStrokeEnable !== undefined) document.getElementById('sub-stroke-enable').checked = ec.subStrokeEnable
  if (ec.subSize) document.getElementById('sub-size').value = ec.subSize
  if (ec.subFont) document.getElementById('sub-font').value = ec.subFont
  if (ec.subShadowEnable !== undefined) {
    document.getElementById('sub-shadow-enable').checked = ec.subShadowEnable
    document.getElementById('sub-shadow-detail-row').style.display = ec.subShadowEnable ? '' : 'none'
  }
  if (ec.subShadowColor) document.getElementById('sub-shadow-color').value = ec.subShadowColor
  if (ec.subShadowOpacity !== undefined) {
    document.getElementById('sub-shadow-opacity').value = ec.subShadowOpacity
    document.getElementById('sub-shadow-opacity-val').textContent = ec.subShadowOpacity + '%'
  }
  if (ec.subShadowAngle !== undefined) {
    document.getElementById('sub-shadow-angle').value = ec.subShadowAngle
    document.getElementById('sub-shadow-angle-val').textContent = ec.subShadowAngle + '°'
  }
  if (ec.subShadowDist !== undefined) document.getElementById('sub-shadow-dist').value = ec.subShadowDist
  updateSubOverlay()
}

function renderTags(tags) {
  const container = document.getElementById('tag-container')
  container.innerHTML = tags.map(t =>
    `<span class="tag">#${t}<button class="tag-remove" data-tag="${t}">×</button></span>`
  ).join('') + `<input type="text" class="tag-add-input" placeholder="+ 添加" id="tag-add">`

  document.getElementById('tag-add')?.addEventListener('keydown', async e => {
    if (e.key !== 'Enter' && e.key !== ',') return
    const val = e.target.value.replace(/^#/, '').trim()
    if (!val) return
    const newTags = [...(sessionData.title?.hashtags || []), val]
    await save({ title: { ...sessionData.title, hashtags: newTags } })
    renderTags(newTags)
  })
}

function updateVideoPreview(videoPath) {
  const ts = Date.now()
  const preview = document.getElementById('video-preview')
  let video = preview.querySelector('video')
  if (!video) {
    video = document.createElement('video')
    video.controls = true
    preview.insertBefore(video, preview.firstChild)
  }
  video.src = `file:///${videoPath.replace(/\\/g, '/')}?t=${ts}`
  video.load()
  document.getElementById('preview-placeholder').style.display = 'none'
  updateSubOverlay()
}

function showCoverPreview(p) {
  document.getElementById('cover-preview').style.display = 'block'
  document.getElementById('cover-img').src = 'file:///' + p.replace(/\\/g, '/')
}

// ── 画中画 ──────────────────────────────────────────────────────
function msToSrtTime(ms) {
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const msec = ms % 1000
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(msec).padStart(3,'0')}`
}

function parseSrt(srtText) {
  const blocks = srtText.trim().split(/\n\s*\n/)
  const result = []
  for (const block of blocks) {
    const lines = block.trim().split('\n')
    if (lines.length < 3) continue
    // 支持标准格式 HH:MM:SS,mmm 和纯毫秒格式
    let start, end
    const stdMatch = lines[1].match(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/)
    if (stdMatch) {
      start = stdMatch[1]; end = stdMatch[2]
    } else {
      const msMatch = lines[1].match(/(\d+)\s*-->\s*(\d+)/)
      if (!msMatch) continue
      start = msToSrtTime(parseInt(msMatch[1]))
      end = msToSrtTime(parseInt(msMatch[2]))
    }
    result.push({ start, end, text: lines.slice(2).join(' ') })
  }
  return result
}

function srtTimeToShort(t) {
  // "00:00:01,234" -> "0:01"
  const m = t.match(/(\d{2}):(\d{2}):(\d{2}),/)
  if (!m) return t
  const mins = parseInt(m[1]) * 60 + parseInt(m[2])
  return `${mins}:${m[3]}`
}

function renderPipList() {
  const srtPath = sessionData.subtitle?.srt_path
  const hint = document.getElementById('pip-hint')
  const list = document.getElementById('pip-list')
  const pickBtn = document.getElementById('pip-pick-selected')
  const segments = sessionData.pipSegments || []
  const groups = sessionData.pipGroups || []

  // 无字幕时：只显示手动片段
  if (!srtPath) {
    hint.style.display = ''
    hint.textContent = segments.length === 0 ? '请先生成字幕，或手动添加替换片段' : '字幕列表将显示在这里'
    pickBtn.style.display = 'none'
    document.getElementById('btn-pip-compose').style.display = groups.length > 0 ? '' : 'none'
    renderPipGroupsOnly(groups)
    return
  }

  if (segments.length === 0) {
    hint.textContent = '字幕已生成但无数据，请重新生成字幕'
    hint.style.display = ''
    pickBtn.style.display = 'none'
    document.getElementById('btn-pip-compose').style.display = groups.length > 0 ? '' : 'none'
    renderPipGroupsOnly(groups)
    return
  }

  hint.style.display = 'none'
  pickBtn.style.display = ''

  // 记录哪些段已被占用
  const usedIndices = new Set()
  groups.forEach(g => (g.segIndices || []).forEach(i => usedIndices.add(i)))

  // 渲染已合并的替换组（字幕片段+手动片段统一显示）
  let groupsHtml = ''
  if (groups.length > 0) {
    groupsHtml = '<div class="pip-groups-header">已添加的替换片段</div>'
    groupsHtml += groups.map((g, gIdx) => {
      const videoName = g.videoPath.split(/[/\\]/).pop()
      const infoText = g.manual
        ? '<span class="pip-manual-tag">手动</span>'
        : `<span class="pip-text">${g.text || ''}</span>`
      const bgmTag = g.coverBgm
        ? '<span class="pip-used-tag">静音</span>'
        : '<span class="pip-bgm-keep-tag">带音</span>'
      return `<div class="pip-group">
        <div class="pip-group-top">
          <span class="pip-time">${srtTimeToShort(g.start)}-${srtTimeToShort(g.end)}</span>
          ${infoText}
          <span class="pip-video-label">${videoName}</span>
          ${bgmTag}
          <button class="pip-btn-edit-group" data-gidx="${gIdx}" title="编辑" style="background:none;border:1px solid var(--border);border-radius:3px;cursor:pointer;padding:1px 6px;font-size:11px;color:var(--blue);flex-shrink:0">编辑</button>
          <button class="pip-btn-remove-group" data-gidx="${gIdx}" title="移除">×</button>
        </div>
        <button class="pip-btn-compose-group btn-green btn-compact" data-gidx="${gIdx}">点击合成</button>
      </div>`
    }).join('')
  }

  // 渲染字幕段列表（带勾选框和编辑）
  const segsHtml = segments.map((seg, idx) => {
    const used = usedIndices.has(idx)
    const editable = !used
    return `<div class="pip-item ${used ? 'pip-item-used' : ''}">
      <input type="checkbox" class="pip-seg-check" data-idx="${idx}" ${used ? 'disabled' : ''}>
      <span class="pip-time-editable" data-idx="${idx}" data-field="start" contenteditable="${editable}" title="${seg.start}">${srtTimeToShort(seg.start)}</span>
      <span style="color:var(--text2);font-size:10px">→</span>
      <span class="pip-time-editable" data-idx="${idx}" data-field="end" contenteditable="${editable}" title="${seg.end}">${srtTimeToShort(seg.end)}</span>
      <span class="pip-text pip-text-editable" contenteditable="${editable}" data-idx="${idx}">${seg.text}</span>
      ${used ? '<span class="pip-used-tag">已替换</span>' : ''}
    </div>`
  }).join('')

  list.innerHTML = groupsHtml + '<div class="pip-segs-header">字幕段落（点击文字或时间可编辑）</div>' + segsHtml

  // 字幕文字编辑
  list.querySelectorAll('.pip-text-editable').forEach(el => {
    el.addEventListener('blur', async () => {
      const idx = parseInt(el.dataset.idx)
      const newText = el.textContent.trim()
      const segs = sessionData.pipSegments || []
      if (segs[idx] && segs[idx].text !== newText) {
        segs[idx].text = newText
        await save({ pipSegments: segs })
      }
      document.getElementById('sub-overlay').textContent = newText || '示例字幕文字'
    })
    el.addEventListener('focus', () => {
      document.getElementById('sub-overlay').textContent = el.textContent || '示例字幕文字'
    })
  })

  // 时间戳编辑
  list.querySelectorAll('.pip-time-editable').forEach(el => {
    el.addEventListener('blur', async () => {
      const idx = parseInt(el.dataset.idx)
      const field = el.dataset.field
      const val = el.textContent.trim()
      const segs = sessionData.pipSegments || []
      if (segs[idx] && /^\d{2}:\d{2}:\d{2},\d{3}$/.test(val)) {
        segs[idx][field] = val
        await save({ pipSegments: segs })
      } else {
        // 格式不对，还原
        el.textContent = segs[idx]?.[field] || ''
      }
    })
  })

  // 全局合成按钮显示控制
  document.getElementById('btn-pip-compose').style.display = groups.length > 0 ? '' : 'none'
}

// 仅渲染替换组列表（无字幕时使用）
function renderPipGroupsOnly(groups) {
  const list = document.getElementById('pip-list')
  if (groups.length === 0) { list.innerHTML = ''; return }
  const groupsHtml = '<div class="pip-groups-header">已添加的替换片段</div>' +
    groups.map((g, gIdx) => {
      const videoName = g.videoPath.split(/[/\\]/).pop()
      const infoText = g.manual
        ? '<span class="pip-manual-tag">手动</span>'
        : `<span class="pip-text">${g.text || ''}</span>`
      const bgmTag = g.coverBgm
        ? '<span class="pip-used-tag">静音</span>'
        : '<span class="pip-bgm-keep-tag">带音</span>'
      return `<div class="pip-group">
        <div class="pip-group-top">
          <span class="pip-time">${srtTimeToShort(g.start)}-${srtTimeToShort(g.end)}</span>
          ${infoText}
          <span class="pip-video-label">${videoName}</span>
          ${bgmTag}
          <button class="pip-btn-edit-group" data-gidx="${gIdx}" title="编辑" style="background:none;border:1px solid var(--border);border-radius:3px;cursor:pointer;padding:1px 6px;font-size:11px;color:var(--blue);flex-shrink:0">编辑</button>
          <button class="pip-btn-remove-group" data-gidx="${gIdx}" title="移除">×</button>
        </div>
        <button class="pip-btn-compose-group btn-green btn-compact" data-gidx="${gIdx}">点击合成</button>
      </div>`
    }).join('')
  list.innerHTML = groupsHtml
}

// ── 预览区生成状态提示 ─────────────────────────────────────────────
function showGenStatus(msg, type) {
  const el = document.getElementById('gen-status')
  el.textContent = msg
  el.className = 'gen-status ' + type
  el.style.display = msg ? '' : 'none'
}

function clearGenStatus() {
  document.getElementById('gen-status').style.display = 'none'
}

// ── 步骤执行 ──────────────────────────────────────────────────────
const STEP_BTN = {
  extract: 'btn-extract',
  rewrite: 'btn-rewrite',
  title: 'btn-title',
  audio: 'btn-audio',
  video: 'btn-video',
  subtitle: 'btn-gen-subtitle',
  edit: 'btn-edit',
  cover: 'btn-design-cover'
}
const STEP_STATUS = {
  extract: '提取中，请稍候...',
  rewrite: 'AI 改写中...',
  title: '生成标题话题中...',
  audio: '音频生成中...',
  video: '视频生成中...',
  subtitle: '字幕生成中...',
  edit: '剪辑合成中...',
  cover: '封面生成中...'
}

function setBtnLoading(step, loading) {
  const btnId = STEP_BTN[step]
  if (!btnId) return
  const btn = document.getElementById(btnId)
  if (!btn) return
  btn.disabled = loading
  if (loading) {
    btn.dataset._origText = btn.textContent
    btn.textContent = STEP_STATUS[step] || '处理中...'
  } else {
    btn.textContent = btn.dataset._origText || btn.textContent
  }
}

async function runStep(step, extraData) {
  if (extraData) await save(extraData)
  setStatus(STEP_STATUS[step] || `${step} 执行中...`)
  document.getElementById('log-drawer').classList.add('open')
  document.getElementById('log-toggle').textContent = '▼ 日志'
  setBtnLoading(step, true)

  let result
  try {
    result = await window.api.stepRun({ step, sessionPath: session.sessionPath })
  } finally {
    setBtnLoading(step, false)
  }
  sessionData = await window.api.sessionRead(session.sessionPath) || sessionData
  refreshUI()
  setStatus(result.code === 0 ? `${step} 完成` : `${step} 失败`)
  return result.code === 0
}

async function runExtract() {
  const url = document.getElementById('url-input').value.trim()
  if (!url) return alert('请输入抖音链接')
  await save({ url })

  const phases = ['提取中，请稍候', '下载视频中...', '下载进度: 0%', '视频已下载', '提取音频中...', 'AI 识别中...']
  let phaseIdx = 0
  const tick = setInterval(() => {
    const btn = document.getElementById('btn-extract')
    if (btn.disabled) {
      btn.textContent = phases[phaseIdx % phases.length]
      phaseIdx++
    } else {
      clearInterval(tick)
    }
  }, 4000)

  const ok = await runStep('extract')
  clearInterval(tick)
  if (ok && autoSteps.rewrite) await runRewrite()
}

async function runRewrite() {
  const ok = await runStep('rewrite')
  if (ok && autoSteps.title) await runTitle()
}

async function runTitle() {
  const ok = await runStep('title')
  if (ok && autoSteps.audio) await runAudio()
}

async function runAudio() {
  const manualPath = document.getElementById('audio-file-path').value.trim()
  if (manualPath) {
    await save({ audio: { audio_path: manualPath } })
    refreshUI()
    if (autoSteps.video) await runVideo()
    return
  }
  const voiceId = document.getElementById('voice-id-input').value.trim()
  const speed = document.getElementById('speed-slider').value
  if (voiceId) await save({ audioConfig: { voiceId, speed: parseFloat(speed) } })

  const ok = await runStep('audio')
  if (ok && autoSteps.video) await runVideo()
}

async function runVideo() {
  const manualPath = document.getElementById('video-file-path').value.trim()
  if (manualPath) {
    await save({ video: { video_path: manualPath } })
    refreshUI()
    if (autoSteps.edit) await runSubtitle()
    return
  }
  // 先把手动上传的音频路径写入 session
  const manualAudio = document.getElementById('audio-file-path').value.trim()
  if (manualAudio) await save({ audio: { audio_path: manualAudio, status: 'done' } })

  const avatarId = document.getElementById('avatar-id-input').value.trim() ||
                   document.getElementById('avatar-select').value
  if (avatarId) await save({ videoConfig: { avatarId } })

  showGenStatus('视频生成中，请稍后...', 'running')
  document.getElementById('btn-cancel-video').style.display = ''
  document.getElementById('btn-video').disabled = true
  const ok = await runStep('video')
  document.getElementById('btn-cancel-video').style.display = 'none'
  document.getElementById('btn-video').disabled = false
  if (ok) {
    showGenStatus('视频生成完成 ✓', 'done')
    if (autoSteps.edit) await runSubtitle()
  } else {
    showGenStatus('视频生成失败', 'error')
  }
}

async function runSubtitle() {
  // 先把手动上传的音频路径写入 session
  const manualAudio = document.getElementById('audio-file-path').value.trim()
  if (manualAudio) await save({ audio: { audio_path: manualAudio, status: 'done' } })

  const ok = await runStep('subtitle')
  if (ok && sessionData.subtitle?.srt_path) {
    try {
      const srtText = await window.api.readFile(sessionData.subtitle.srt_path)
      if (!srtText) throw new Error('empty')
      const segments = parseSrt(srtText)
      const pipData = segments.map(seg => ({ start: seg.start, end: seg.end, text: seg.text }))
      await save({ pipSegments: pipData, pipGroups: [] })
      renderPipList()
    } catch (e) {
      console.error('解析 SRT 失败', e)
    }
  }
}

async function runEdit() {
  // 释放视频播放器，避免 final.mp4 被占用导致 PermissionError
  const previewVideo = document.querySelector('#video-preview video')
  if (previewVideo) { previewVideo.pause(); previewVideo.src = ''; previewVideo.load() }

  const bgmPath = document.getElementById('bgm-path').value.trim()
  const subtitleEnable = document.getElementById('subtitle-enable').checked
  const subColor = document.getElementById('sub-color').value
  const subStrokeEnable = document.getElementById('sub-stroke-enable').checked
  const subStroke = document.getElementById('sub-stroke').value
  const subSize = document.getElementById('sub-size').value
  const subFont = document.getElementById('sub-font').value
  const subShadowEnable = document.getElementById('sub-shadow-enable').checked
  const subShadowColor = document.getElementById('sub-shadow-color').value
  const subShadowOpacity = parseInt(document.getElementById('sub-shadow-opacity').value)
  const subShadowAngle = parseInt(document.getElementById('sub-shadow-angle').value)
  const subShadowDist = parseInt(document.getElementById('sub-shadow-dist').value)
  const voiceVol = parseFloat(document.getElementById('voice-vol').value)
  const bgmVol = parseFloat(document.getElementById('bgm-vol').value)
  const subMarginV = Math.round(subMarginPct / 100 * 288)
  const cfg = { bgmPath, subtitleEnable, subColor, subStrokeEnable, subStroke, subSize: parseInt(subSize), subFont, subShadowEnable, subShadowColor, subShadowOpacity, subShadowAngle, subShadowDist, voiceVol, bgmVol, subMarginV, pip: (sessionData.pipGroups || []).filter(p => p.videoPath) }
  await save({ editConfig: cfg })

  // 如果开启了字幕且还没生成，先自动生成字幕
  if (subtitleEnable && !sessionData.subtitle?.srt_path) {
    setStatus('自动生成字幕中...')
    const ok = await runStep('subtitle')
    if (!ok) return
  }

  // 每次剪辑前，从最新 SRT 文件刷新 pipSegments，避免用旧的不完整数据
  if (subtitleEnable && sessionData.subtitle?.srt_path) {
    try {
      const srtText = await window.api.readFile(sessionData.subtitle.srt_path)
      if (srtText) {
        const segments = parseSrt(srtText)
        const pipData = segments.map(seg => ({ start: seg.start, end: seg.end, text: seg.text }))
        await save({ pipSegments: pipData })
        renderPipList()
      }
    } catch (e) { console.error('刷新 pipSegments 失败', e) }
  }

  showGenStatus('视频合成中，请稍后...', 'running')
  const ok = await runStep('edit')

  // 剪辑完成后用合成视频更新预览
  if (ok) {
    if (sessionData.edit?.output_path) {
      updateVideoPreview(sessionData.edit.output_path)
      document.getElementById('btn-restore-original').style.display = ''
      document.getElementById('btn-open-output-folder').style.display = ''
    }
    showGenStatus('视频合成完成 ✓', 'done')
  } else {
    showGenStatus('视频合成失败', 'error')
  }
}

// ── 封面设计弹窗 ──────────────────────────────────────────────────
let _coverBgImagePath = null  // 用户上传的背景图路径
let _coverBgMode = 'video'    // 'video' | 'image'
let _coverLayout = 'minimal'  // 当前版式
let _coverDragTarget = null   // 正在拖动的文字块 'main' | 'sub'
let _coverTextPos = { main: null, sub: null }  // 文字位置 {x,y} 百分比

// 版式预设：返回 {mainPos, subPos, mainSize, subSize, overlayOpacity}
function getCoverLayoutPreset(layout, mainLen) {
  const presets = {
    minimal: { mainPos: { x: 50, y: 38 }, subPos: { x: 50, y: 58 }, mainSize: 200, subSize: 80, overlayOpacity: 20 },
    four:    { mainPos: { x: 50, y: 35 }, subPos: { x: 50, y: 58 }, mainSize: 170, subSize: 80, overlayOpacity: 30 },
    title:   { mainPos: { x: 50, y: 30 }, subPos: { x: 50, y: 52 }, mainSize: 130, subSize: 70, overlayOpacity: 40 },
    long:    { mainPos: { x: 50, y: 25 }, subPos: { x: 50, y: 55 }, mainSize: 100, subSize: 60, overlayOpacity: 50 },
  }
  return presets[layout] || presets.minimal
}

function openCoverDesignModal() {
  const videoPath = sessionData.edit?.output_path || sessionData.video?.video_path
  if (!videoPath) return alert('请先生成视频')

  const modal = document.getElementById('cover-design-modal')
  modal.style.display = 'flex'

  // 从 session 恢复设计参数
  const d = sessionData.cover?.design || {}
  document.getElementById('cd-main-title').value  = d.mainTitle  || sessionData.title?.title || ''
  document.getElementById('cd-sub-title').value   = d.subTitle   || ''
  document.getElementById('cd-main-font').value   = d.mainFont   || 'Microsoft YaHei'
  document.getElementById('cd-main-size').value   = d.mainSize   || 160
  document.getElementById('cd-main-color').value  = d.mainColor  || '#FFFFFF'
  document.getElementById('cd-main-stroke').value = d.mainStroke || '#000000'
  document.getElementById('cd-sub-font').value    = d.subFont    || 'Microsoft YaHei'
  document.getElementById('cd-sub-size').value    = d.subSize    || 90
  document.getElementById('cd-sub-color').value   = d.subColor   || '#FFD232'
  document.getElementById('cd-sub-stroke').value  = d.subStroke  || '#000000'
  document.getElementById('cd-style').value       = d.style      || 'dark'
  document.getElementById('cover-bg-time-input').value = d.bgFrame || 2.5
  document.getElementById('cover-overlay-opacity').value = d.overlayOpacity ?? 35
  document.getElementById('cover-overlay-opacity-val').textContent = (d.overlayOpacity ?? 35) + '%'

  _coverLayout = d.layout || 'minimal'
  _coverTextPos = { main: d.mainPos || null, sub: d.subPos || null }
  _coverBgMode = d.bgImage ? 'image' : 'video'
  _coverBgImagePath = d.bgImage || null

  // 版式按钮高亮
  document.querySelectorAll('.cover-layout-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.layout === _coverLayout)
  })

  // 背景 tab
  document.querySelectorAll('.cover-bg-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === _coverBgMode)
  })
  document.getElementById('cover-bg-video-panel').style.display = _coverBgMode === 'video' ? '' : 'none'
  document.getElementById('cover-bg-image-panel').style.display = _coverBgMode === 'image' ? '' : 'none'

  // 加载视频到截帧播放器
  const bgVid = document.getElementById('cover-bg-video')
  bgVid.src = 'file:///' + videoPath.replace(/\\/g, '/')
  bgVid.style.display = 'block'
  bgVid.currentTime = parseFloat(document.getElementById('cover-bg-time-input').value) || 2.5

  renderCoverCanvas()
}

function closeCoverDesignModal() {
  document.getElementById('cover-design-modal').style.display = 'none'
  const bgVid = document.getElementById('cover-bg-video')
  bgVid.pause(); bgVid.src = ''; bgVid.style.display = 'none'
}

async function renderCoverCanvas() {
  const canvas = document.getElementById('cover-canvas')
  const ctx = canvas.getContext('2d')
  const W = canvas.width, H = canvas.height

  ctx.clearRect(0, 0, W, H)

  // 背景
  let bgSrc = null
  if (_coverBgMode === 'image' && _coverBgImagePath) {
    bgSrc = 'file:///' + _coverBgImagePath.replace(/\\/g, '/')
  } else {
    const bgVid = document.getElementById('cover-bg-video')
    if (bgVid.readyState >= 2) {
      ctx.drawImage(bgVid, 0, 0, W, H)
    } else {
      ctx.fillStyle = '#111'
      ctx.fillRect(0, 0, W, H)
    }
    drawCoverOverlayAndText(ctx, W, H)
    return
  }

  const img = new Image()
  img.onload = () => {
    // crop center
    const scale = Math.max(W / img.width, H / img.height)
    const sw = W / scale, sh = H / scale
    const sx = (img.width - sw) / 2, sy = (img.height - sh) / 2
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H)
    drawCoverOverlayAndText(ctx, W, H)
  }
  img.src = bgSrc
}

function drawCoverOverlayAndText(ctx, W, H) {
  const style = document.getElementById('cd-style').value
  const opacity = parseInt(document.getElementById('cover-overlay-opacity').value) / 100

  // 蒙层
  if (style === 'dark') {
    ctx.fillStyle = `rgba(0,0,0,${opacity})`
  } else {
    ctx.fillStyle = `rgba(255,255,255,${opacity})`
  }
  ctx.fillRect(0, 0, W, H)

  const preset = getCoverLayoutPreset(_coverLayout)
  const mainTitle = document.getElementById('cd-main-title').value
  const subTitle  = document.getElementById('cd-sub-title').value
  const mainFont  = document.getElementById('cd-main-font').value
  const mainSize  = Math.round(parseInt(document.getElementById('cd-main-size').value) * W / 1080)
  const mainColor = document.getElementById('cd-main-color').value
  const mainStroke = document.getElementById('cd-main-stroke').value
  const subFont   = document.getElementById('cd-sub-font').value
  const subSize   = Math.round(parseInt(document.getElementById('cd-sub-size').value) * W / 1080)
  const subColor  = document.getElementById('cd-sub-color').value
  const subStroke = document.getElementById('cd-sub-stroke').value

  const mainPos = _coverTextPos.main || preset.mainPos
  const subPos  = _coverTextPos.sub  || preset.subPos

  if (mainTitle) {
    drawCanvasText(ctx, mainTitle, mainFont, mainSize, mainColor, mainStroke,
      mainPos.x / 100 * W, mainPos.y / 100 * H)
  }
  if (subTitle) {
    drawCanvasText(ctx, subTitle, subFont, subSize, subColor, subStroke,
      subPos.x / 100 * W, subPos.y / 100 * H)
  }
}

function drawCanvasText(ctx, text, fontName, size, color, strokeColor, cx, cy) {
  const fontMap = {
    'Microsoft YaHei': 'Microsoft YaHei, 微软雅黑',
    'SimHei': 'SimHei, 黑体',
    'KaiTi': 'KaiTi, 楷体',
    'SimSun': 'SimSun, 宋体',
    'FangSong': 'FangSong, 仿宋',
    'YouYuan': 'YouYuan, 幼圆',
  }
  ctx.font = `bold ${size}px ${fontMap[fontName] || fontName}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const sw = Math.max(1, Math.round(size * 0.06))
  ctx.strokeStyle = strokeColor
  ctx.lineWidth = sw * 2
  ctx.lineJoin = 'round'
  ctx.strokeText(text, cx, cy)
  ctx.fillStyle = color
  ctx.fillText(text, cx, cy)
}

function initCoverDesignModal() {
  document.getElementById('btn-close-cover-modal').onclick = closeCoverDesignModal
  document.getElementById('cover-design-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('cover-design-modal')) closeCoverDesignModal()
  })

  // 背景 tab 切换
  document.querySelectorAll('.cover-bg-tab').forEach(btn => {
    btn.onclick = () => {
      _coverBgMode = btn.dataset.tab
      document.querySelectorAll('.cover-bg-tab').forEach(b => b.classList.toggle('active', b === btn))
      document.getElementById('cover-bg-video-panel').style.display = _coverBgMode === 'video' ? '' : 'none'
      document.getElementById('cover-bg-image-panel').style.display = _coverBgMode === 'image' ? '' : 'none'
      renderCoverCanvas()
    }
  })

  // 版式切换
  document.querySelectorAll('.cover-layout-btn').forEach(btn => {
    btn.onclick = () => {
      _coverLayout = btn.dataset.layout
      _coverTextPos = { main: null, sub: null }  // 重置位置到预设
      document.querySelectorAll('.cover-layout-btn').forEach(b => b.classList.toggle('active', b === btn))
      const preset = getCoverLayoutPreset(_coverLayout)
      document.getElementById('cd-main-size').value = preset.mainSize
      document.getElementById('cd-sub-size').value  = preset.subSize
      document.getElementById('cover-overlay-opacity').value = preset.overlayOpacity
      document.getElementById('cover-overlay-opacity-val').textContent = preset.overlayOpacity + '%'
      renderCoverCanvas()
    }
  })

  // 视频时间轴点击
  const timeline = document.getElementById('cover-bg-timeline')
  timeline.addEventListener('click', e => {
    const rect = timeline.getBoundingClientRect()
    const pct = (e.clientX - rect.left) / rect.width
    const bgVid = document.getElementById('cover-bg-video')
    if (bgVid.duration) {
      const t = pct * bgVid.duration
      bgVid.currentTime = t
      document.getElementById('cover-bg-time-input').value = t.toFixed(1)
      document.getElementById('cover-bg-timeline-bar').style.left = (pct * 100) + '%'
    }
  })

  // 截取按钮
  document.getElementById('btn-cover-bg-capture').onclick = () => {
    const t = parseFloat(document.getElementById('cover-bg-time-input').value) || 0
    const bgVid = document.getElementById('cover-bg-video')
    bgVid.currentTime = t
    bgVid.addEventListener('seeked', () => renderCoverCanvas(), { once: true })
  }

  // 视频 seeked → 更新时间轴指示器 + 重绘
  document.getElementById('cover-bg-video').addEventListener('seeked', () => {
    const bgVid = document.getElementById('cover-bg-video')
    if (bgVid.duration) {
      const pct = bgVid.currentTime / bgVid.duration
      document.getElementById('cover-bg-timeline-bar').style.left = (pct * 100) + '%'
    }
    renderCoverCanvas()
  })

  // 上传背景图
  document.getElementById('btn-cover-bg-pick').onclick = async () => {
    const p = await window.api.openFile({
      title: '选择背景图片',
      filters: [{ name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
    })
    if (p) {
      _coverBgImagePath = p
      document.getElementById('cover-bg-image-name').textContent = p.split(/[/\\]/).pop()
      renderCoverCanvas()
    }
  }

  // 蒙层透明度
  document.getElementById('cover-overlay-opacity').addEventListener('input', e => {
    document.getElementById('cover-overlay-opacity-val').textContent = e.target.value + '%'
    renderCoverCanvas()
  })

  // 所有文字/样式控件变化 → 重绘
  ;['cd-main-title','cd-sub-title','cd-main-font','cd-main-size','cd-main-color','cd-main-stroke',
    'cd-sub-font','cd-sub-size','cd-sub-color','cd-sub-stroke','cd-style'].forEach(id => {
    const el = document.getElementById(id)
    el.addEventListener('input', () => renderCoverCanvas())
    el.addEventListener('change', () => renderCoverCanvas())
  })

  // Canvas 文字拖动
  const canvas = document.getElementById('cover-canvas')
  canvas.addEventListener('mousedown', e => {
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    const mx = (e.clientX - rect.left) * scaleX
    const my = (e.clientY - rect.top) * scaleY
    const W = canvas.width, H = canvas.height
    const preset = getCoverLayoutPreset(_coverLayout)
    const mainPos = _coverTextPos.main || preset.mainPos
    const subPos  = _coverTextPos.sub  || preset.subPos
    const mainX = mainPos.x / 100 * W, mainY = mainPos.y / 100 * H
    const subX  = subPos.x  / 100 * W, subY  = subPos.y  / 100 * H
    const hitR = 40
    if (Math.abs(mx - mainX) < hitR && Math.abs(my - mainY) < hitR) {
      _coverDragTarget = 'main'
    } else if (Math.abs(mx - subX) < hitR && Math.abs(my - subY) < hitR) {
      _coverDragTarget = 'sub'
    }
  })
  canvas.addEventListener('mousemove', e => {
    if (!_coverDragTarget) return
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    const mx = (e.clientX - rect.left) * scaleX
    const my = (e.clientY - rect.top) * scaleY
    const W = canvas.width, H = canvas.height
    _coverTextPos[_coverDragTarget] = {
      x: Math.max(5, Math.min(95, mx / W * 100)),
      y: Math.max(5, Math.min(95, my / H * 100))
    }
    renderCoverCanvas()
  })
  canvas.addEventListener('mouseup', () => { _coverDragTarget = null })
  canvas.addEventListener('mouseleave', () => { _coverDragTarget = null })

  // AI 生成标题
  document.getElementById('btn-cover-ai-title').onclick =
  document.getElementById('btn-cover-gen-title').onclick = async () => {
    const title = sessionData.title?.title || ''
    if (title) {
      document.getElementById('cd-main-title').value = title
      renderCoverCanvas()
    } else {
      alert('请先生成视频标题（步骤3）')
    }
  }

  // 生成封面
  document.getElementById('btn-cover-confirm').onclick = async () => {
    await genCoverFromModal()
  }
}

async function genCoverFromModal() {
  const videoPath = sessionData.edit?.output_path || sessionData.video?.video_path
  if (!videoPath) return alert('请先生成视频')

  const preset = getCoverLayoutPreset(_coverLayout)
  const mainPos = _coverTextPos.main || preset.mainPos
  const subPos  = _coverTextPos.sub  || preset.subPos

  const design = {
    mainTitle:  document.getElementById('cd-main-title').value.trim(),
    subTitle:   document.getElementById('cd-sub-title').value.trim(),
    mainFont:   document.getElementById('cd-main-font').value,
    mainSize:   parseInt(document.getElementById('cd-main-size').value),
    mainColor:  document.getElementById('cd-main-color').value,
    mainStroke: document.getElementById('cd-main-stroke').value,
    subFont:    document.getElementById('cd-sub-font').value,
    subSize:    parseInt(document.getElementById('cd-sub-size').value),
    subColor:   document.getElementById('cd-sub-color').value,
    subStroke:  document.getElementById('cd-sub-stroke').value,
    style:      document.getElementById('cd-style').value,
    bgFrame:    parseFloat(document.getElementById('cover-bg-time-input').value) || 2.5,
    bgImage:    _coverBgMode === 'image' ? _coverBgImagePath : null,
    overlayOpacity: parseInt(document.getElementById('cover-overlay-opacity').value),
    layout:     _coverLayout,
    mainPos, subPos,
  }

  await save({ cover: { ...sessionData.cover, design } })

  closeCoverDesignModal()
  const ok = await runStep('cover')
  if (ok && sessionData.cover) {
    document.getElementById('cover-tabs').style.display = 'flex'
    document.querySelectorAll('.cover-tab').forEach(t => t.classList.remove('active'))
    document.querySelector('.cover-tab[data-platform="douyin"]').classList.add('active')
    const coverPath = sessionData.cover.douyin || sessionData.cover.path || ''
    if (coverPath) {
      document.getElementById('cover-path').value = coverPath
      showCoverPreview(coverPath)
      document.getElementById('btn-open-cover').style.display = ''
    }
  }
}

async function genCover() { await genCoverFromModal() }



async function runPipCompose(gIdx) {
  // 优先使用预览区的当前视频（可能是已合成的），否则用原始视频
  const videoPath = sessionData.edit?.output_path || sessionData.video?.video_path
  if (!videoPath) return alert('请先生成数字人视频')

  const groups = sessionData.pipGroups || []
  if (groups.length === 0) return alert('请先添加替换视频片段')

  // 单个片段合成时，只取该片段
  const pipGroups = gIdx !== undefined ? [groups[gIdx]] : groups.filter(p => p.videoPath)
  if (!pipGroups.length) return alert('无效的替换片段')

  // 准备 editConfig
  const bgmPath = document.getElementById('bgm-path').value.trim()
  const subtitleEnable = document.getElementById('subtitle-enable').checked
  const subColor = document.getElementById('sub-color').value
  const subStrokeEnable = document.getElementById('sub-stroke-enable').checked
  const subStroke = document.getElementById('sub-stroke').value
  const subSize = document.getElementById('sub-size').value
  const subFont = document.getElementById('sub-font').value
  const subShadowEnable = document.getElementById('sub-shadow-enable').checked
  const subShadowColor = document.getElementById('sub-shadow-color').value
  const subShadowOpacity = parseInt(document.getElementById('sub-shadow-opacity').value)
  const subShadowAngle = parseInt(document.getElementById('sub-shadow-angle').value)
  const subShadowDist = parseInt(document.getElementById('sub-shadow-dist').value)
  const voiceVol = parseFloat(document.getElementById('voice-vol').value)
  const bgmVol = parseFloat(document.getElementById('bgm-vol').value)
  await save({ editConfig: { bgmPath, subtitleEnable, subColor, subStrokeEnable, subStroke, subSize: parseInt(subSize), subFont, subShadowEnable, subShadowColor, subShadowOpacity, subShadowAngle, subShadowDist, voiceVol, bgmVol, subMarginV: Math.round(subMarginPct / 100 * 288), pip: pipGroups } })

  // 先自动生成字幕（如果需要）
  if (subtitleEnable && !sessionData.subtitle?.srt_path) {
    setStatus('自动生成字幕中...')
    const ok = await runStep('subtitle')
    if (!ok) return
  }

  showGenStatus('视频合成中，请稍后...', 'running')
  const ok = await runStep('edit')
  if (ok) {
    if (sessionData.edit?.output_path) {
      updateVideoPreview(sessionData.edit.output_path)
      document.getElementById('btn-restore-original').style.display = ''
      document.getElementById('btn-open-output-folder').style.display = ''
    }
    showGenStatus('视频合成完成 ✓', 'done')
  } else {
    showGenStatus('视频合成失败', 'error')
  }
}

async function runPublish() {
  const platforms = ['douyin', 'xiaohongshu', 'weixin'].filter(id =>
    document.getElementById(`pub-${id}`)?.checked
  )
  if (platforms.length === 0) return alert('请选择发布平台')

  const videoPath = sessionData.edit?.output_path || sessionData.video?.video_path
  if (!videoPath) return alert('请先生成视频')

  const title = sessionData.title?.title || ''
  const hashtags = sessionData.title?.hashtags || []
  // 描述用改写后的文案，没有则用原标题
  const description = sessionData.rewrite?.rewritten || title
  const publishAction = document.getElementById('publish-action').value
  const logEl = document.getElementById('publish-log')
  logEl.innerHTML = ''

  for (const platform of platforms) {
    logEl.innerHTML += `<div>发布到 ${platform}...</div>`
    // 使用对应平台的封面
    const platCover = sessionData.cover?.[platform] || sessionData.cover?.path || ''
    const result = await window.api.publishRun({
      platform, videoPath, title, hashtags,
      coverPath: platCover,
      description,
      publishAction
    })
    logEl.innerHTML += result.success
      ? `<div style="color:var(--green)">✅ ${platform} 成功</div>`
      : `<div style="color:#F88">❌ ${platform}: ${result.error}</div>`
  }
}

// ── 设置 ──────────────────────────────────────────────────────────
async function openSettings() {
  const cfg = await window.api.configRead()
  document.getElementById('cfg-python').value = cfg.pythonPath || ''
  document.getElementById('cfg-downloader').value = cfg.douyinDownloaderPath || ''
  document.getElementById('cfg-anthropic-base').value = cfg.anthropicBaseUrl || ''
  document.getElementById('cfg-anthropic-key').value = cfg.anthropicApiKey || ''
  document.getElementById('cfg-fish-key').value = cfg.fishApiKey || ''
  document.getElementById('cfg-fish-voice').value = cfg.fishVoiceId || ''
  document.getElementById('cfg-heygen-key').value = cfg.heygenApiKey || ''
  document.getElementById('cfg-heygen-avatar').value = cfg.heygenAvatarId || ''
  document.getElementById('cfg-proxy').value = cfg.proxy || ''

  // 预填 voice-id 和 avatar-id
  if (cfg.fishVoiceId) document.getElementById('voice-id-input').value = cfg.fishVoiceId
  if (cfg.heygenAvatarId) document.getElementById('avatar-id-input').value = cfg.heygenAvatarId

  document.getElementById('settings-modal').style.display = 'flex'
}

async function saveSettings() {
  const cfg = {
    pythonPath: document.getElementById('cfg-python').value.trim(),
    douyinDownloaderPath: document.getElementById('cfg-downloader').value.trim(),
    anthropicBaseUrl: document.getElementById('cfg-anthropic-base').value.trim(),
    anthropicApiKey: document.getElementById('cfg-anthropic-key').value.trim(),
    fishApiKey: document.getElementById('cfg-fish-key').value.trim(),
    fishVoiceId: document.getElementById('cfg-fish-voice').value.trim(),
    heygenApiKey: document.getElementById('cfg-heygen-key').value.trim(),
    heygenAvatarId: document.getElementById('cfg-heygen-avatar').value.trim(),
    proxy: document.getElementById('cfg-proxy').value.trim()
  }
  // 保留 rewritePrompt（不在设置弹窗里，单独保存）
  const existing = await window.api.configRead()
  if (existing.rewritePrompt !== undefined) cfg.rewritePrompt = existing.rewritePrompt
  await window.api.configWrite(cfg)
  if (cfg.fishVoiceId) document.getElementById('voice-id-input').value = cfg.fishVoiceId
  if (cfg.heygenAvatarId) document.getElementById('avatar-id-input').value = cfg.heygenAvatarId
  document.getElementById('settings-modal').style.display = 'none'
  setStatus('设置已保存')
}

const DEFAULT_REWRITE_PROMPT = `你是一位专业的短视频文案创作者。请将以下口播文案改写为全新原创内容。

# 人设定位
干练、直接，适合对着镜头朗读。

# 结构要求
直接输出改写后的完整文案正文，不需要添加标题、小标题、编号或任何额外说明。

# 严格限制
- 不得改变原文的核心观点和主要信息
- 不得凭空捏造案例、数据、引用或任何事实性内容
- 不得在原文未涉及人设的情况下强行植入用户人设信息
- 不得使用抖音平台违禁词和绝对化表述
- 不得输出任何非文案正文的内容（如分析过程、改写说明等）
- 用户人设信息中的真实背景不得篡改或夸大

# 执行指令
严格按照上述要求输出改写后的完整文案。

原始文案：
{raw}`

async function openPromptModal() {
  const cfg = await window.api.configRead()
  document.getElementById('prompt-textarea').value = cfg.rewritePrompt || DEFAULT_REWRITE_PROMPT
  document.getElementById('prompt-modal').style.display = 'flex'
}

async function savePrompt() {
  const cfg = await window.api.configRead()
  cfg.rewritePrompt = document.getElementById('prompt-textarea').value.trim()
  await window.api.configWrite(cfg)
  document.getElementById('prompt-modal').style.display = 'none'
  setStatus('提示词已保存')
}

// ── BGM 预设 ──────────────────────────────────────────────────────
async function loadBgmPresets() {
  const list = await window.api.bgmList()
  const sel = document.getElementById('bgm-preset')
  list.forEach(({ name, path }) => {
    const opt = document.createElement('option')
    opt.value = path
    opt.textContent = name
    sel.appendChild(opt)
  })
}

// ── 字幕 Overlay ──────────────────────────────────────────────────
let subMarginPct = 28  // 距底部百分比，默认 28%

function updateSubOverlay() {
  const overlay = document.getElementById('sub-overlay')
  const enable = document.getElementById('subtitle-enable').checked
  if (!enable) { overlay.style.display = 'none'; return }

  const color = document.getElementById('sub-color').value || '#ffffff'
  const strokeEnable = document.getElementById('sub-stroke-enable').checked
  const stroke = document.getElementById('sub-stroke').value || '#000000'
  const size = parseInt(document.getElementById('sub-size').value) || 24
  const font = document.getElementById('sub-font').value || 'Microsoft YaHei'
  const shadowEnable = document.getElementById('sub-shadow-enable').checked
  const shadowColor = document.getElementById('sub-shadow-color').value || '#000000'
  const shadowOpacity = parseInt(document.getElementById('sub-shadow-opacity').value ?? 80) / 100
  const shadowAngle = parseInt(document.getElementById('sub-shadow-angle').value ?? 135) * Math.PI / 180
  const shadowDist = parseInt(document.getElementById('sub-shadow-dist').value ?? 2)
  const shadowDx = (shadowDist * Math.cos(shadowAngle)).toFixed(1)
  const shadowDy = (shadowDist * Math.sin(shadowAngle)).toFixed(1)
  const sr = parseInt(shadowColor.slice(1,3),16), sg = parseInt(shadowColor.slice(3,5),16), sb = parseInt(shadowColor.slice(5,7),16)
  const shadowRgba = `rgba(${sr},${sg},${sb},${shadowOpacity})`

  overlay.style.display = 'block'
  overlay.style.color = color
  overlay.style.fontFamily = font
  overlay.style.fontSize = size + 'px'
  overlay.style.webkitTextStroke = strokeEnable ? `1px ${stroke}` : '0px transparent'
  overlay.style.textShadow = shadowEnable ? `${shadowDx}px ${shadowDy}px 4px ${shadowRgba}` : 'none'
  overlay.style.fontWeight = 'bold'
  overlay.style.bottom = subMarginPct + '%'
  overlay.style.border = ''
  overlay.style.borderRadius = ''
  overlay.style.padding = ''
  // guide 跟随字幕位置
  const guide = document.getElementById('sub-guide')
  if (guide) guide.style.bottom = subMarginPct + '%'
}

// ── 画中画位置预览画布 ─────────────────────────────────────────────
function initPipPosCanvas(filePath, startSec) {
  const canvas = document.getElementById('pip-pos-canvas')
  const el = document.getElementById('pip-pos-el')
  const img = document.getElementById('pip-pos-img')
  const vid = document.getElementById('pip-pos-video')
  const resizeHandle = document.getElementById('pip-pos-resize')

  // 用主视频截图作为背景
  const mainVideo = document.querySelector('#video-preview video')
  function captureFrame() {
    if (!mainVideo || mainVideo.readyState < 2) return
    const tmpCanvas = document.createElement('canvas')
    tmpCanvas.width = mainVideo.videoWidth || 148
    tmpCanvas.height = mainVideo.videoHeight || 263
    tmpCanvas.getContext('2d').drawImage(mainVideo, 0, 0)
    canvas.style.backgroundImage = `url(${tmpCanvas.toDataURL()})`
    canvas.style.backgroundSize = 'cover'
    canvas.style.backgroundPosition = 'center'
  }
  if (mainVideo) {
    if (startSec !== undefined) {
      mainVideo.currentTime = startSec
      mainVideo.addEventListener('seeked', captureFrame, { once: true })
    } else {
      captureFrame()
    }
  }

  const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(filePath)
  if (isImage) {
    img.src = filePath; img.style.display = 'block'; vid.style.display = 'none'
  } else {
    vid.src = filePath; vid.style.display = 'block'; img.style.display = 'none'
  }

  const cw = () => canvas.offsetWidth || 148
  const ch = () => canvas.offsetHeight || 263

  function getElRect() {
    return {
      l: parseFloat(el.style.left) || 0,
      t: parseFloat(el.style.top)  || 0,
      w: parseFloat(el.style.width)  || cw(),
      h: parseFloat(el.style.height) || ch(),
    }
  }

  function syncFromInputs() {
    const x = parseFloat(document.getElementById('pip-confirm-x').value) || 0
    const y = parseFloat(document.getElementById('pip-confirm-y').value) || 0
    const w = parseFloat(document.getElementById('pip-confirm-w').value) || 100
    const h = parseFloat(document.getElementById('pip-confirm-h').value) || 100
    el.style.left   = (x / 100 * cw()) + 'px'
    el.style.top    = (y / 100 * ch()) + 'px'
    el.style.width  = (w / 100 * cw()) + 'px'
    el.style.height = (h / 100 * ch()) + 'px'
    syncResizeHandle()
    syncCropOverlay()
  }

  function syncToInputs() {
    const r = getElRect()
    document.getElementById('pip-confirm-x').value = Math.max(0, Math.min(100, Math.round(r.l / cw() * 100)))
    document.getElementById('pip-confirm-y').value = Math.max(0, Math.min(100, Math.round(r.t / ch() * 100)))
    document.getElementById('pip-confirm-w').value = Math.max(5, Math.min(100, Math.round(r.w / cw() * 100)))
    document.getElementById('pip-confirm-h').value = Math.max(5, Math.min(100, Math.round(r.h / ch() * 100)))
    syncResizeHandle()
  }

  function syncResizeHandle() {
    const r = getElRect()
    resizeHandle.style.left = (r.l + r.w - 14) + 'px'
    resizeHandle.style.top  = (r.t + r.h - 14) + 'px'
  }

  const cropInputs = {
    top:    document.getElementById('pip-crop-top'),
    bottom: document.getElementById('pip-crop-bottom'),
    left:   document.getElementById('pip-crop-left'),
    right:  document.getElementById('pip-crop-right'),
  }
  const cropOverlays = {
    top:    document.getElementById('pip-crop-overlay-top'),
    bottom: document.getElementById('pip-crop-overlay-bottom'),
    left:   document.getElementById('pip-crop-overlay-left'),
    right:  document.getElementById('pip-crop-overlay-right'),
  }

  function syncCropOverlay() {
    const r = getElRect()
    const t = Math.max(0, Math.min(90, parseFloat(cropInputs.top.value)    || 0))
    const b = Math.max(0, Math.min(90, parseFloat(cropInputs.bottom.value) || 0))
    const l = Math.max(0, Math.min(90, parseFloat(cropInputs.left.value)   || 0))
    const rv = Math.max(0, Math.min(90, parseFloat(cropInputs.right.value) || 0))
    cropOverlays.top.style.height    = (t / 100 * r.h) + 'px'
    cropOverlays.bottom.style.height = (b / 100 * r.h) + 'px'
    cropOverlays.left.style.width    = (l / 100 * r.w) + 'px'
    cropOverlays.right.style.width   = (rv / 100 * r.w) + 'px'
    document.getElementById('pip-crop-handle-top').style.top       = (t / 100 * r.h) + 'px'
    document.getElementById('pip-crop-handle-bottom').style.bottom = (b / 100 * r.h) + 'px'
    document.getElementById('pip-crop-handle-left').style.left     = (l / 100 * r.w) + 'px'
    document.getElementById('pip-crop-handle-right').style.right   = (rv / 100 * r.w) + 'px'
  }

  Object.values(cropInputs).forEach(inp => inp.addEventListener('input', syncCropOverlay))

  syncFromInputs()
  requestAnimationFrame(() => { syncFromInputs() })

  ;['pip-confirm-x','pip-confirm-y','pip-confirm-w','pip-confirm-h'].forEach(id => {
    document.getElementById(id).oninput = syncFromInputs
  })

  // ── 统一在 canvas 上处理所有鼠标交互 ──────────────────────────────
  const EDGE = 12  // 裁剪感应区（el 边缘内侧）
  const RESIZE_PX = 20  // resize 手柄感应区（canvas 右下角）

  function getMode(e) {
    const cr = canvas.getBoundingClientRect()
    const cx = e.clientX - cr.left, cy = e.clientY - cr.top
    const r = getElRect()

    // resize 手柄：canvas 坐标系下 el 右下角 RESIZE_PX 范围
    if (cx >= r.l + r.w - RESIZE_PX && cx <= r.l + r.w + 4 &&
        cy >= r.t + r.h - RESIZE_PX && cy <= r.t + r.h + 4) {
      return { mode: 'resize' }
    }

    // 是否在 el 范围内
    if (cx < r.l || cx > r.l + r.w || cy < r.t || cy > r.t + r.h) return null

    // 裁剪边缘
    if (cy - r.t < EDGE) return { mode: 'crop', side: 'top' }
    if (r.t + r.h - cy < EDGE) return { mode: 'crop', side: 'bottom' }
    if (cx - r.l < EDGE) return { mode: 'crop', side: 'left' }
    if (r.l + r.w - cx < EDGE) return { mode: 'crop', side: 'right' }

    return { mode: 'drag' }
  }

  function onCanvasMouseDown(e) {
    const hit = getMode(e)
    if (!hit) return
    e.preventDefault(); e.stopPropagation()

    const cr = canvas.getBoundingClientRect()
    const startCX = e.clientX - cr.left, startCY = e.clientY - cr.top
    const r0 = getElRect()

    if (hit.mode === 'resize') {
      const onMove = ev => {
        const cx2 = ev.clientX - cr.left, cy2 = ev.clientY - cr.top
        let newW = Math.max(cw() * 0.05, Math.min(cw() - r0.l, r0.w + (cx2 - startCX)))
        let newH = Math.max(ch() * 0.05, Math.min(ch() - r0.t, r0.h + (cy2 - startCY)))
        if (window._pipRatioLocked) {
          const ratio = r0.w / r0.h
          const byW = r0.w + (cx2 - startCX)
          const byH = r0.h + (cy2 - startCY)
          if (byW / ratio < byH) {
            newW = Math.max(cw() * 0.05, Math.min(cw() - r0.l, byW))
            newH = newW / ratio
          } else {
            newH = Math.max(ch() * 0.05, Math.min(ch() - r0.t, byH))
            newW = newH * ratio
          }
        }
        el.style.width  = newW + 'px'
        el.style.height = newH + 'px'
        syncToInputs()
        syncCropOverlay()
      }
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)

    } else if (hit.mode === 'crop') {
      const side = hit.side
      const onMove = ev => {
        const r2 = getElRect()
        let pct
        const cx2 = ev.clientX - cr.left, cy2 = ev.clientY - cr.top
        if (side === 'top')    pct = Math.max(0, Math.min(90, (cy2 - r2.t) / r2.h * 100))
        if (side === 'bottom') pct = Math.max(0, Math.min(90, (r2.t + r2.h - cy2) / r2.h * 100))
        if (side === 'left')   pct = Math.max(0, Math.min(90, (cx2 - r2.l) / r2.w * 100))
        if (side === 'right')  pct = Math.max(0, Math.min(90, (r2.l + r2.w - cx2) / r2.w * 100))
        cropInputs[side].value = Math.round(pct)
        syncCropOverlay()
      }
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)

    } else if (hit.mode === 'drag') {
      const onMove = ev => {
        const cx2 = ev.clientX - cr.left, cy2 = ev.clientY - cr.top
        const newL = Math.max(0, Math.min(cw() - r0.w, r0.l + (cx2 - startCX)))
        const newT = Math.max(0, Math.min(ch() - r0.h, r0.t + (cy2 - startCY)))
        el.style.left = newL + 'px'
        el.style.top  = newT + 'px'
        syncToInputs()
      }
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    }
  }

  // 更新 cursor
  function onCanvasMouseMove(e) {
    const hit = getMode(e)
    if (!hit) { canvas.style.cursor = 'default'; return }
    if (hit.mode === 'resize') canvas.style.cursor = 'se-resize'
    else if (hit.mode === 'drag') canvas.style.cursor = 'move'
    else canvas.style.cursor = { top: 'n-resize', bottom: 's-resize', left: 'w-resize', right: 'e-resize' }[hit.side]
  }

  if (window._pipCanvasDown)  canvas.removeEventListener('mousedown',  window._pipCanvasDown)
  if (window._pipCanvasMove)  canvas.removeEventListener('mousemove',  window._pipCanvasMove)
  window._pipCanvasDown = onCanvasMouseDown
  window._pipCanvasMove = onCanvasMouseMove
  canvas.addEventListener('mousedown', onCanvasMouseDown)
  canvas.addEventListener('mousemove', onCanvasMouseMove)
}

function initSubOverlay() {
  const overlay = document.getElementById('sub-overlay')
  const preview = document.getElementById('video-preview')
  let dragging = false, startY = 0, startPct = 0

  overlay.addEventListener('mousedown', e => {
    dragging = true
    startY = e.clientY
    startPct = subMarginPct
    overlay.classList.add('dragging')
    e.preventDefault()
  })

  document.addEventListener('mousemove', e => {
    if (!dragging) return
    const h = preview.getBoundingClientRect().height
    const dy = startY - e.clientY  // 向上拖为正
    const deltaPct = (dy / h) * 100
    subMarginPct = Math.max(0, Math.min(90, startPct + deltaPct))
    overlay.style.bottom = subMarginPct + '%'
  })

  document.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false
    overlay.classList.remove('dragging')
    // 保存位置到 session
    const marginV = Math.round(subMarginPct / 100 * 288)
    if (session) {
      const cfg = sessionData.editConfig || {}
      save({ editConfig: { ...cfg, subMarginV: marginV } })
    }
  })

  updateSubOverlay()
}

init()

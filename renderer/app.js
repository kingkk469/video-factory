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
  document.getElementById('cover-main-title').value = ''
  document.getElementById('cover-sub-title').value = ''
  document.getElementById('cover-main-color').value = '#FFFFFF'
  document.getElementById('cover-main-size').value  = '160'
  document.getElementById('cover-sub-color').value  = '#FFD232'
  document.getElementById('cover-sub-size').value   = '90'
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
  document.getElementById('cover-main-title').value = ''
  document.getElementById('cover-sub-title').value = ''
  document.getElementById('cover-main-color').value = '#FFFFFF'
  document.getElementById('cover-main-size').value  = '160'
  document.getElementById('cover-sub-color').value  = '#FFD232'
  document.getElementById('cover-sub-size').value   = '90'
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
  }

  // 步骤按钮
  document.getElementById('btn-extract').onclick = runExtract
  document.getElementById('btn-rewrite').onclick = runRewrite
  document.getElementById('btn-title').onclick = runTitle
  document.getElementById('btn-audio').onclick = runAudio
  document.getElementById('btn-video').onclick = runVideo
  document.getElementById('btn-edit').onclick = runEdit
  document.getElementById('btn-publish').onclick = runPublish
  document.getElementById('btn-gen-subtitle').onclick = runSubtitle
  // 封面生成
  document.getElementById('btn-gen-cover').onclick = genCover
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
  document.getElementById('btn-restore-original').onclick = async () => {
    if (!confirm('确定还原到原始视频（去除画中画效果）？')) return
    sessionData.edit = { ...sessionData.edit, output_path: '' }
    await save({ edit: sessionData.edit })
    const originalPath = sessionData.video?.video_path
    if (originalPath) updateVideoPreview(originalPath)
    document.getElementById('btn-restore-original').style.display = 'none'
    clearGenStatus()
  }

  // 背景音乐选择
  document.getElementById('btn-pick-bgm').onclick = async () => {
    const p = await window.api.openFile({
      title: '选择背景音乐',
      filters: [{ name: '音频文件', extensions: ['mp3', 'wav', 'm4a', 'aac'] }]
    })
    console.log('[btn-pick-bgm] selected:', p)
    if (p) {
      document.getElementById('bgm-path').value = p
      console.log('[btn-pick-bgm] set bgm-path to:', p)
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
    if (p) document.getElementById('video-file-path').value = p
  }

  // (cover-path is now hidden, manual pick handled by btn-pick-cover)

  // 画中画列表事件委托
  document.getElementById('pip-list').addEventListener('click', async e => {
    const composeBtn = e.target.closest('.pip-btn-compose-group')
    const removeBtn = e.target.closest('.pip-btn-remove-group')
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
      title: '选择替换视频',
      filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm'] }]
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
    document.getElementById('pip-confirm-end').value = ''
    document.getElementById('pip-confirm-end-hint').textContent = srtTimeToShort(lastSeg.end)
    document.getElementById('pip-confirm-cover-bgm').checked = false
    document.getElementById('pip-confirm-modal').style.display = 'flex'
  })

  // 确认弹窗事件
  document.getElementById('btn-close-pip-modal').onclick = () => { document.getElementById('pip-confirm-modal').style.display = 'none' }
  document.getElementById('btn-cancel-pip-modal').onclick = () => { document.getElementById('pip-confirm-modal').style.display = 'none' }
  document.getElementById('pip-confirm-modal').onclick = e => { if (e.target.id === 'pip-confirm-modal') e.target.style.display = 'none' }
  document.getElementById('btn-confirm-pip-modal').onclick = async () => {
    if (!_pendingPip) return
    const coverBgm = document.getElementById('pip-confirm-cover-bgm').checked
    // 如果用户手动修改了结束时间，用修改值；否则用字幕段的结束时间
    const endOverride = document.getElementById('pip-confirm-end').value.trim()
    const end = endOverride && /^\d{2}:\d{2}:\d{2},\d{3}$/.test(endOverride)
      ? endOverride
      : _pendingPip.end
    const groups = sessionData.pipGroups || []
    groups.push({ ..._pendingPip, end, coverBgm })
    await save({ pipGroups: groups })
    _pendingPip = null
    document.getElementById('pip-confirm-modal').style.display = 'none'
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
  // 主标题：优先用设计参数，其次用视频标题作为默认提示
  document.getElementById('cover-main-title').value = coverDesign.mainTitle || sessionData.title?.title || ''
  document.getElementById('cover-sub-title').value = coverDesign.subTitle || ''
  document.getElementById('cover-style').value = coverDesign.style || 'dark'
  document.getElementById('cover-bg-time').value = coverDesign.bgFrame || 2.5
  document.getElementById('cover-main-font').value   = coverDesign.mainFont   || 'Microsoft YaHei'
  document.getElementById('cover-main-color').value  = coverDesign.mainColor  || '#FFFFFF'
  document.getElementById('cover-main-size').value   = coverDesign.mainSize   || '160'
  document.getElementById('cover-main-stroke').value = coverDesign.mainStroke || '#000000'
  document.getElementById('cover-sub-font').value     = coverDesign.subFont    || 'Microsoft YaHei'
  document.getElementById('cover-sub-color').value    = coverDesign.subColor  || '#FFD232'
  document.getElementById('cover-sub-size').value     = coverDesign.subSize    || '90'
  document.getElementById('cover-sub-stroke').value   = coverDesign.subStroke || '#000000'

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
  preview.innerHTML = `<video controls src="file:///${videoPath.replace(/\\/g, '/')}?t=${ts}"></video>`
}

function showCoverPreview(p) {
  document.getElementById('cover-preview').style.display = 'block'
  document.getElementById('cover-img').src = 'file:///' + p.replace(/\\/g, '/')
}

// ── 画中画 ──────────────────────────────────────────────────────
function parseSrt(srtText) {
  const blocks = srtText.trim().split(/\n\s*\n/)
  const result = []
  for (const block of blocks) {
    const lines = block.trim().split('\n')
    if (lines.length < 3) continue
    const timeMatch = lines[1].match(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/)
    if (!timeMatch) continue
    result.push({
      start: timeMatch[1],
      end: timeMatch[2],
      text: lines.slice(2).join(' ')
    })
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
          <button class="pip-btn-remove-group" data-gidx="${gIdx}" title="移除">×</button>
        </div>
        <button class="pip-btn-compose-group btn-green btn-compact" data-gidx="${gIdx}">点击合成</button>
      </div>`
    }).join('')
  }

  // 渲染字幕段列表（带勾选框）
  const segsHtml = segments.map((seg, idx) => {
    const used = usedIndices.has(idx)
    return `<div class="pip-item ${used ? 'pip-item-used' : ''}">
      <input type="checkbox" class="pip-seg-check" data-idx="${idx}" ${used ? 'disabled' : ''}>
      <span class="pip-time">${srtTimeToShort(seg.start)}-${srtTimeToShort(seg.end)}</span>
      <span class="pip-text">${seg.text}</span>
      ${used ? '<span class="pip-used-tag">已替换</span>' : ''}
    </div>`
  }).join('')

  list.innerHTML = groupsHtml + '<div class="pip-segs-header">字幕段落（勾选后点击上方按钮）</div>' + segsHtml

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
  cover: 'btn-gen-cover'
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
  const avatarId = document.getElementById('avatar-id-input').value.trim() ||
                   document.getElementById('avatar-select').value
  const teethHd = document.getElementById('teeth-hd').checked
  const motionRandom = document.getElementById('motion-random').checked
  if (avatarId) await save({ videoConfig: { avatarId, teethHd, motionRandom } })

  showGenStatus('视频生成中，请稍后...', 'running')
  const ok = await runStep('video')
  if (ok) {
    showGenStatus('视频生成完成 ✓', 'done')
    if (autoSteps.edit) await runSubtitle()
  } else {
    showGenStatus('视频生成失败', 'error')
  }
}

async function runSubtitle() {
  const ok = await runStep('subtitle')
  if (ok && sessionData.subtitle?.srt_path) {
    // 读取 SRT 文件内容，解析成 pip 初始数据
    try {
      const resp = await fetch('file:///' + sessionData.subtitle.srt_path.replace(/\\/g, '/'))
      const srtText = await resp.text()
      const segments = parseSrt(srtText)
      const pipData = segments.map(seg => ({
        start: seg.start,
        end: seg.end,
        text: seg.text
      }))
      await save({ pipSegments: pipData, pipGroups: [] })
      renderPipList()
    } catch (e) {
      console.error('解析 SRT 失败', e)
    }
  }
}

async function runEdit() {
  const bgmPath = document.getElementById('bgm-path').value.trim()
  console.log('[runEdit] bgmPath from input:', bgmPath)
  const subtitleEnable = document.getElementById('subtitle-enable').checked
  const subColor = document.getElementById('sub-color').value
  const subStroke = document.getElementById('sub-stroke').value
  const subSize = document.getElementById('sub-size').value
  const subFont = document.getElementById('sub-font').value
  const voiceVol = parseFloat(document.getElementById('voice-vol').value)
  const bgmVol = parseFloat(document.getElementById('bgm-vol').value)
  const cfg = { bgmPath, subtitleEnable, subColor, subStroke, subSize: parseInt(subSize), subFont, voiceVol, bgmVol, pip: (sessionData.pipGroups || []).filter(p => p.videoPath) }
  console.log('[runEdit] saving editConfig with bgmPath:', bgmPath)
  await save({ editConfig: cfg })

  // 如果开启了字幕且还没生成，先自动生成字幕
  if (subtitleEnable && !sessionData.subtitle?.srt_path) {
    setStatus('自动生成字幕中...')
    const ok = await runStep('subtitle')
    if (!ok) return
  }

  showGenStatus('视频合成中，请稍后...', 'running')
  const ok = await runStep('edit')

  // 剪辑完成后用合成视频更新预览
  if (ok && sessionData.edit?.output_path) {
    updateVideoPreview(sessionData.edit.output_path)
    document.getElementById('btn-restore-original').style.display = ''
    showGenStatus('视频合成完成 ✓', 'done')
  } else if (!ok) {
    showGenStatus('视频合成失败', 'error')
  }
}

async function genCover() {
  const videoPath = sessionData.video?.video_path
  if (!videoPath) return alert('请先生成视频')

  // 如果主标题为空，自动填入视频标题作为默认值
  const mainTitleEl = document.getElementById('cover-main-title')
  if (!mainTitleEl.value.trim() && sessionData.title?.title) {
    mainTitleEl.value = sessionData.title.title
  }

  const mainTitle = mainTitleEl.value.trim()
  const subTitle = document.getElementById('cover-sub-title').value.trim()
  const style = document.getElementById('cover-style').value
  const bgFrame = parseFloat(document.getElementById('cover-bg-time').value) || 2.5

  // 主标题样式
  const mainFont   = document.getElementById('cover-main-font').value
  const mainColor  = document.getElementById('cover-main-color').value || '#FFFFFF'
  const mainSize   = parseInt(document.getElementById('cover-main-size').value) || 160
  const mainStroke = document.getElementById('cover-main-stroke').value || '#000000'

  // 副标题样式
  const subFont   = document.getElementById('cover-sub-font').value
  const subColor  = document.getElementById('cover-sub-color').value || '#FFD232'
  const subSize   = parseInt(document.getElementById('cover-sub-size').value) || null
  const subStroke = document.getElementById('cover-sub-stroke').value || '#000000'

  await save({
    cover: {
      ...sessionData.cover,
      design: {
        mainTitle, subTitle, style, bgFrame,
        mainFont, mainColor, mainSize, mainStroke,
        subFont, subColor, subSize, subStroke,
      }
    }
  })

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
  const subStroke = document.getElementById('sub-stroke').value
  const subSize = document.getElementById('sub-size').value
  const subFont = document.getElementById('sub-font').value
  const voiceVol = parseFloat(document.getElementById('voice-vol').value)
  const bgmVol = parseFloat(document.getElementById('bgm-vol').value)
  await save({ editConfig: { bgmPath, subtitleEnable, subColor, subStroke, subSize: parseInt(subSize), subFont, voiceVol, bgmVol, pip: pipGroups } })

  // 先自动生成字幕（如果需要）
  if (subtitleEnable && !sessionData.subtitle?.srt_path) {
    setStatus('自动生成字幕中...')
    const ok = await runStep('subtitle')
    if (!ok) return
  }

  showGenStatus('视频合成中，请稍后...', 'running')
  const ok = await runStep('edit')
  if (ok && sessionData.edit?.output_path) {
    updateVideoPreview(sessionData.edit.output_path)
    document.getElementById('btn-restore-original').style.display = ''
    showGenStatus('视频合成完成 ✓', 'done')
  } else if (!ok) {
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
  await window.api.configWrite(cfg)
  if (cfg.fishVoiceId) document.getElementById('voice-id-input').value = cfg.fishVoiceId
  if (cfg.heygenAvatarId) document.getElementById('avatar-id-input').value = cfg.heygenAvatarId
  document.getElementById('settings-modal').style.display = 'none'
  setStatus('设置已保存')
}

init()

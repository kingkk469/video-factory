const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')

let win = null

process.on('uncaughtException', (err) => {
  const msg = err.stack || err.message
  try {
    const crashPath = path.join(app.getPath('userData'), 'crash.log')
    fs.writeFileSync(crashPath, msg)
  } catch(e) {}
  try { dialog.showErrorBox('启动错误', msg) } catch(e) {}
})

// sessions 放在用户数据目录（asar 外部）
let SESSIONS_DIR = ''
const SCRIPTS_DIR = path.join(__dirname, 'scripts')
// bundle 用 asarUnpack，在打包后指向 app.asar.unpacked/bundle
// 开发模式下 __dirname 已经指向项目根目录
const CONFIG_PATH = '' // 延迟初始化

// 判断是否在打包后运行（asar 模式）
const IS_PACKAGED = app.isPackaged

// 如果在打包后，bundle 在 asar 外部
function getBundlePath() {
  if (IS_PACKAGED) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'bundle')
  }
  return path.join(__dirname, 'bundle')
}

// 启动时把打包的 ffmpeg 注入 PATH（优先使用）
function initBundlePath() {
  const bundlePath = getBundlePath()
  const ffmpegPath = path.join(bundlePath, 'ffmpeg')
  if (fs.existsSync(ffmpegPath)) {
    const oldPath = process.env.PATH || ''
    if (!oldPath.split(path.delimiter).includes(ffmpegPath)) {
      process.env.PATH = ffmpegPath + path.delimiter + oldPath
    }
  }
}
initBundlePath()

// 默认配置
const DEFAULT_CONFIG = {
  pythonPath: 'python',
  douyinDownloaderPath: '',
  anthropicBaseUrl: 'https://api.anthropic.com',
  anthropicApiKey: '',
  fishApiKey: '',
  fishVoiceId: '',
  heygenApiKey: '',
  heygenAvatarId: '',
  proxy: ''
}

function loadConfig() {
  try {
    const cfgPath = path.join(app.getPath('userData'), 'config.json')
    if (fs.existsSync(cfgPath)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')) }
    }
  } catch (e) {}
  return { ...DEFAULT_CONFIG }
}

function saveConfig(cfg) {
  const cfgPath = path.join(app.getPath('userData'), 'config.json')
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#F5F5F7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.loadFile('renderer/index.html')
}

app.whenReady().then(() => {
  SESSIONS_DIR = path.join(app.getPath('userData'), 'sessions')
  fs.mkdirSync(SESSIONS_DIR, { recursive: true })
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ── Session 管理 ──────────────────────────────────────────────────

ipcMain.handle('session:create', () => {
  const id = Date.now().toString()
  const dir = path.join(SESSIONS_DIR, id)
  fs.mkdirSync(dir, { recursive: true })
  const session = { id, createdAt: new Date().toISOString() }
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(session, null, 2))
  return { id, dir, sessionPath: path.join(dir, 'session.json') }
})

ipcMain.handle('session:read', (_, sessionPath) => {
  try {
    return JSON.parse(fs.readFileSync(sessionPath, 'utf8'))
  } catch (e) {
    return null
  }
})

ipcMain.handle('session:write', (_, sessionPath, data) => {
  fs.writeFileSync(sessionPath, JSON.stringify(data, null, 2))
  return true
})

ipcMain.handle('session:list', () => {
  try {
    return fs.readdirSync(SESSIONS_DIR)
      .map(id => {
        const p = path.join(SESSIONS_DIR, id, 'session.json')
        try { return { id, data: JSON.parse(fs.readFileSync(p, 'utf8')) } } catch { return null }
      })
      .filter(Boolean)
      .sort((a, b) => b.id - a.id)
      .slice(0, 15)
  } catch { return [] }
})

ipcMain.handle('session:rename', (_, id, name) => {
  const p = path.join(SESSIONS_DIR, id, 'session.json')
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'))
    data.name = name
    fs.writeFileSync(p, JSON.stringify(data, null, 2))
    return true
  } catch { return false }
})

ipcMain.handle('session:delete', (_, id) => {
  const dir = path.join(SESSIONS_DIR, id)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return true
  } catch { return false }
})

// ── 环境检测 ─────────────────────────────────────────────────────

ipcMain.handle('env:check', () => {
  const { execSync } = require('child_process')
  const cfg = loadConfig()
  const results = {}

  // ffmpeg：优先检查打包的，再检查系统 PATH
  const bundledFfmpeg = path.join(getBundlePath(), 'ffmpeg', 'ffmpeg.exe')
  if (fs.existsSync(bundledFfmpeg)) {
    results.ffmpeg = { ok: true, source: 'bundled' }
  } else {
    try {
      execSync('ffmpeg -version', { stdio: 'ignore' })
      results.ffmpeg = { ok: true, source: 'system' }
    } catch {
      results.ffmpeg = { ok: false, hint: '请安装 ffmpeg，下载地址：https://www.gyan.dev/ffmpeg/builds/' }
    }
  }

  // Python：检查配置的路径
  const pythonExe = cfg.pythonPath || 'python'
  try {
    const ver = execSync(pythonExe + ' --version', { stdio: 'pipe' }).toString().trim()
    results.python = { ok: true, version: ver, path: pythonExe }
  } catch {
    results.python = { ok: false, hint: '无法找到 Python，请在设置中配置 Python 路径' }
  }

  // 关键 Python 包检测（如果 Python 可用）
  if (results.python.ok) {
    // import 名 -> 显示名
    const packages = [
      { imp: 'faster_whisper', label: 'faster-whisper' },
      { imp: 'rookiepy', label: 'rookiepy' },
      { imp: 'anthropic', label: 'anthropic' },
      { imp: 'PIL', label: 'Pillow' },
      { imp: 'requests', label: 'requests' },
    ]
    results.pythonPackages = {}
    for (const { imp, label } of packages) {
      try {
        execSync(pythonExe + ' -c "import ' + imp + '"', { stdio: 'ignore' })
        results.pythonPackages[label] = { ok: true }
      } catch {
        results.pythonPackages[label] = { ok: false }
      }
    }
  }

  return results
})

// ── 配置管理 ──────────────────────────────────────────────────────

ipcMain.handle('config:read', () => loadConfig())
ipcMain.handle('config:write', (_, cfg) => { saveConfig(cfg); return true })

// ── Python 步骤执行 ───────────────────────────────────────────────

const runningProcesses = {}

ipcMain.handle('step:run', (event, { step, sessionPath }) => {
  const cfg = loadConfig()
  const python = cfg.pythonPath || 'python'
  const script = path.join(SCRIPTS_DIR, 'pipeline.py')

  const env = {
    ...process.env,
    VF_SESSION: sessionPath,
    VF_STEP: step,
    VF_DOWNLOADER: cfg.douyinDownloaderPath,
    VF_ANTHROPIC_BASE: cfg.anthropicBaseUrl,
    VF_ANTHROPIC_KEY: cfg.anthropicApiKey,
    VF_FISH_KEY: cfg.fishApiKey,
    VF_FISH_VOICE: cfg.fishVoiceId,
    VF_HEYGEN_KEY: cfg.heygenApiKey,
    VF_HEYGEN_AVATAR: cfg.heygenAvatarId,
    HTTP_PROXY: cfg.proxy || process.env.HTTP_PROXY || '',
    HTTPS_PROXY: cfg.proxy || process.env.HTTPS_PROXY || '',
    VF_REWRITE_PROMPT: cfg.rewritePrompt || ''
  }

  const proc = spawn(python, [script, '--step', step, '--session', sessionPath], { env })
  runningProcesses[step] = proc

  proc.stdout.on('data', data => {
    data.toString().split('\n').forEach(line => {
      line = line.trim()
      if (!line) return
      try {
        const msg = JSON.parse(line)
        event.sender.send('step:log', msg)
      } catch {
        event.sender.send('step:log', { type: 'progress', message: line })
      }
    })
  })

  proc.stderr.on('data', data => {
    event.sender.send('step:log', { type: 'progress', message: data.toString().trim() })
  })

  return new Promise(resolve => {
    proc.on('close', code => {
      delete runningProcesses[step]
      resolve({ code })
    })
  })
})

ipcMain.handle('step:cancel', (_, step) => {
  if (runningProcesses[step]) {
    runningProcesses[step].kill()
    delete runningProcesses[step]
  }
  return true
})

// ── 发布模块 ──────────────────────────────────────────────────────

ipcMain.handle('publish:run', async (event, { platform, videoPath, title, hashtags, coverPath, description, publishAction }) => {
  const publishScript = path.join(__dirname, 'publish', `${platform}.js`)
  if (!fs.existsSync(publishScript)) {
    return { success: false, error: `发布脚本不存在: ${platform}` }
  }
  try {
    const publisher = require(publishScript)
    await publisher.publish({ videoPath, title, hashtags, coverPath, description, publishAction }, msg => {
      event.sender.send('step:log', { type: 'progress', message: msg })
    })
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// 打开文件夹
ipcMain.handle('shell:openPath', (_, p) => shell.openPath(p))
// 打开文件夹并选中文件
ipcMain.handle('shell:showItemInFolder', (_, p) => shell.showItemInFolder(p))

// 文件选择对话框
ipcMain.handle('dialog:openFile', async (_, opts) => {
  const result = await dialog.showOpenDialog(win, { properties: ['openFile'], ...opts })
  return result.canceled ? null : result.filePaths[0]
})

// BGM 预设列表
ipcMain.handle('bgm:list', () => {
  const dir = path.join(__dirname, '背景音乐')
  try {
    return fs.readdirSync(dir)
      .filter(f => /\.(mp3|wav|m4a|aac)$/i.test(f))
      .map(f => ({ name: f.replace(/\.[^.]+$/, ''), path: path.join(dir, f) }))
  } catch { return [] }
})

// 读取文本文件
ipcMain.handle('fs:readText', (_, filePath) => {
  try { return fs.readFileSync(filePath, 'utf8') } catch { return null }
})

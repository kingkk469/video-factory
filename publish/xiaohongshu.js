/**
 * 小红书创作者平台自动发布
 */
const { chromium } = require('playwright')
const path = require('path')
const { app } = require('electron')
const fs = require('fs')

const PROFILE_DIR = path.join(app.getPath('userData'), 'playwright-profiles', 'xiaohongshu')
const DEBUG_DIR = path.join(app.getPath('userData'), 'video-factory', 'debug')

async function ensureDebugDir() {
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true })
}

async function capture(page, name) {
  await page.screenshot({ path: path.join(DEBUG_DIR, name), fullPage: true }).catch(() => {})
}

async function waitForEventFileChooser(page, selector, log) {
  try {
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5000 }),
      page.click(selector, { timeout: 5000 })
    ])
    return fileChooser
  } catch (e) {
    return null
  }
}

async function uploadFileViaInput(page, selectors, filePath, description, log) {
  for (const sel of selectors) {
    const input = await page.$(sel)
    if (!input) continue
    try {
      await input.setInputFiles(filePath)
      log(`${description} 设置完成`)
      return true
    } catch (e) {}
  }
  return false
}

async function fillTextField(page, selectors, text, log) {
  if (!text) return false
  for (const sel of selectors) {
    const el = await page.$(sel)
    if (!el) continue
    try {
      await el.click()
      await page.keyboard.down('Control')
      await page.keyboard.press('A')
      await page.keyboard.up('Control')
      await page.keyboard.press('Backspace')
      await el.type(text, { delay: 30 })
      log(`填写完成: ${text.slice(0, 20)}...`)
      return true
    } catch (e) {}
  }
  return false
}

async function publish({ videoPath, title, hashtags, coverPath, description }, log) {
  await ensureDebugDir()
  log('启动浏览器...')
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 }
  })
  const page = browser.pages()[0] || await browser.newPage()

  try {
    log('打开小红书创作者平台...')
    await page.goto('https://creator.xiaohongshu.com/publish/publish', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(2000)

    if (page.url().includes('login') || page.url().includes('signin')) {
      log('请在浏览器中登录小红书...')
      await page.waitForURL('**/publish/**', { timeout: 120000 })
      log('登录成功')
      await page.waitForTimeout(2000)
    }

    await capture(page, 'xhs_01_page.png')

    // 点击视频上传
    log('选择视频上传...')
    const videoTabSelectors = ['text=上传视频', 'text=发布视频', '[class*="video"]']
    for (const sel of videoTabSelectors) {
      const el = await page.$(sel)
      if (el) {
        try {
          await el.click()
          await page.waitForTimeout(1500)
          break
        } catch {}
      }
    }

    // 上传视频
    log('上传视频文件...')
    const videoSelectors = ['input[type="file"][accept*="video"]', 'input[type="file"]']
    let uploaded = await uploadFileViaInput(page, videoSelectors, videoPath, '视频', log)
    if (!uploaded) {
      const chooser = await waitForEventFileChooser(page, 'text=上传视频', log)
      if (chooser) {
        await chooser.setFiles(videoPath)
        log('视频通过文件选择器上传')
      }
    }

    // 等待上传
    log('等待视频上传...')
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(5000)
      const progress = await page.$('[class*="progress"], [class*="uploading"]')
      const success = await page.$('[class*="success"], video[src]')
      if (!progress || success) {
        log('视频上传完成')
        break
      }
    }

    await capture(page, 'xhs_02_upload.png')

    // 封面
    if (coverPath) {
      log('上传封面...')
      const coverSelectors = ['input[type="file"][accept*="image"]', 'input[accept*="jpg"]']
      uploaded = await uploadFileViaInput(page, coverSelectors, coverPath, '封面', log)
      if (!uploaded) {
        const chooser = await waitForEventFileChooser(page, 'text=上传封面', log)
        if (chooser) await chooser.setFiles(coverPath)
      }
      await page.waitForTimeout(2000)
    }

    // 标题
    await fillTextField(page, [
      'input[placeholder*="标题"]',
      '[class*="title"] input'
    ], title, log)

    // 描述 + 话题
    const fullDesc = description + (hashtags.length > 0 ? '\n' + hashtags.slice(0, 5).map(t => `#${t}`).join(' ') : '')
    await fillTextField(page, [
      'textarea[placeholder*="正文"]',
      'textarea[placeholder*="内容"]',
      'textarea[placeholder*="描述"]',
      '[class*="content"] textarea'
    ], fullDesc, log)

    await capture(page, 'xhs_03_filled.png')

    log('视频/封面/标题/描述已填入，请手动确认后发布')
    log(`调试截图: ${DEBUG_DIR}`)
    log('等待关闭浏览器...')
    await page.waitForEvent('close', { timeout: 600000 })

  } catch (e) {
    log(`出错: ${e.message}`)
    await capture(page, 'xhs_error.png')
    await page.waitForEvent('close', { timeout: 600000 })
  }

  await browser.close().catch(() => {})
}

module.exports = { publish }

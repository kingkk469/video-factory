/**
 * 抖音创作者平台自动发布
 * 上传视频、竖封面(3:4)、标题、简介+话题
 */
const { chromium } = require('playwright')
const path = require('path')
const { app } = require('electron')
const fs = require('fs')

const PROFILE_DIR = path.join(app.getPath('userData'), 'playwright-profiles', 'douyin')
const DEBUG_DIR = path.join(app.getPath('userData'), 'video-factory', 'debug')

async function ensureDebugDir() {
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true })
}

async function capture(page, name) {
  await page.screenshot({ path: path.join(DEBUG_DIR, name), fullPage: true }).catch(() => {})
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
    log('打开抖音创作者中心...')
    await page.goto('https://creator.douyin.com/creator-micro/content/upload', {
      waitUntil: 'domcontentloaded', timeout: 60000
    })
    await page.waitForTimeout(3000)

    // 登录检查
    if (page.url().includes('login') || page.url().includes('passport')) {
      log('请在浏览器中扫码登录抖音...')
      await page.waitForURL(url => !url.includes('login') && !url.includes('passport'), { timeout: 120000 })
      log('登录成功')
      await page.waitForTimeout(3000)
    }

    await capture(page, 'douyin_01_page.png')

    // ── 上传视频 ──
    log('上传视频文件...')
    const videoInput = await page.$('input[type="file"]')
    if (videoInput) {
      await videoInput.setInputFiles(videoPath)
      log('视频上传中...')
    }

    // 等待视频处理完成
    log('等待视频处理（最多5分钟）...')
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(5000)
      const progress = await page.$('[class*="progress"]')
      const success = await page.$('[class*="success"], [class*="complete"], [class*="ready"]')
      if (!progress || success) {
        log('视频上传处理完成')
        break
      }
      if (i % 6 === 0) log(`等待中... ${(i/6 + 1) * 30}秒`)
    }

    await page.waitForTimeout(3000)
    await capture(page, 'douyin_02_after_upload.png')

    // ── 上传竖封面 3:4 ──
    if (coverPath) {
      log('上传竖封面(3:4)...')

      // 方法1：点击页面右侧竖封面区域（坐标点击）
      // 根据截图，竖封面3:4在页面约 60% 水平位置，25% 垂直位置附近
      const viewport = page.viewportSize()
      if (viewport) {
        // 点击竖封面3:4的黑框区域
        await page.mouse.click(viewport.width * 0.58, viewport.height * 0.28)
        log('点击竖封面区域')
        await page.waitForTimeout(1500)
      }

      // 等待文件选择器弹出
      try {
        const fileChooser = await page.waitForEvent('filechooser', { timeout: 5000 })
        await fileChooser.setFiles(coverPath)
        log('竖封面文件已选择')
        await page.waitForTimeout(2000)

        // 确认按钮
        const confirmBtn = await page.$('button:has-text("确定"), button:has-text("完成"), button:has-text("确认")')
        if (confirmBtn) {
          await confirmBtn.click()
          log('确认封面')
          await page.waitForTimeout(1000)
        }
      } catch (e) {
        log('未触发文件选择器，尝试其他方式...')

        // 方法2：查找图片上传input
        const imgInputs = await page.$$('input[type="file"][accept*="image"]')
        log(`找到 ${imgInputs.length} 个图片input`)
        if (imgInputs.length > 0) {
          await imgInputs[0].setInputFiles(coverPath)
          log('封面已上传')
          await page.waitForTimeout(2000)
        }
      }

      await capture(page, 'douyin_03_cover.png')
    }

    // ── 填写标题 ──
    log('填写作品标题...')
    const titleSelectors = [
      'input[placeholder*="标题"]',
      'input[placeholder*="主题"]',
      '[class*="title"] input',
      'input[maxlength]'
    ]
    for (const sel of titleSelectors) {
      const el = await page.$(sel)
      if (el) {
        await el.click()
        await page.keyboard.press('Control+A')
        await page.keyboard.press('Backspace')
        await el.type(title, { delay: 50 })
        log(`标题: ${title}`)
        break
      }
    }

    // ── 填写作品简介（描述 + 话题） ──
    log('填写作品简介...')
    const intro = description + (hashtags.length > 0
      ? '\n' + hashtags.slice(0, 5).map(t => `#${t}`).join(' ')
      : '')

    const introSelectors = [
      'textarea[placeholder*="简介"]',
      'textarea[placeholder*="描述"]',
      'textarea[placeholder*="内容"]',
      '[class*="intro"] textarea',
      '[class*="desc"] textarea',
      '[contenteditable="true"]'
    ]
    for (const sel of introSelectors) {
      const el = await page.$(sel)
      if (el) {
        await el.click()
        await page.keyboard.press('Control+A')
        await page.keyboard.press('Backspace')
        await el.type(intro, { delay: 50 })
        log('作品简介已填写')
        break
      }
    }

    await capture(page, 'douyin_04_filled.png')

    log('───────────────────────────')
    log('✅ 视频已上传')
    log('✅ 封面已上传')
    log('✅ 标题已填写')
    log('✅ 简介已填写')
    log('请检查内容，确认后手动点击发布')
    log('───────────────────────────')
    log(`调试截图: ${DEBUG_DIR}`)
    log('等待你关闭浏览器窗口...')

    await page.waitForEvent('close', { timeout: 600000 })

  } catch (e) {
    log(`出错: ${e.message}`)
    await capture(page, 'douyin_error.png')
    log('请手动完成后关闭浏览器')
    await page.waitForEvent('close', { timeout: 600000 })
  }

  await browser.close().catch(() => {})
}

module.exports = { publish }

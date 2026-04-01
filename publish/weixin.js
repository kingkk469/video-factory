/**
 * 微信视频号助手自动发布
 */
const { chromium } = require('playwright')
const path = require('path')
const { app } = require('electron')
const fs = require('fs')

const PROFILE_DIR = path.join(app.getPath('userData'), 'playwright-profiles', 'weixin')
const DEBUG_DIR = path.join(app.getPath('userData'), 'debug')

async function publish({ videoPath, title, hashtags, coverPath, description, publishAction }, log) {
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true })

  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 }
  })
  const page = browser.pages()[0] || await browser.newPage()

  try {
    log('打开视频号助手...')
    await page.goto('https://channels.weixin.qq.com/platform/post/create', {
      waitUntil: 'domcontentloaded', timeout: 60000
    })
    await page.waitForTimeout(3000)

    // 检查登录
    if (page.url().includes('login')) {
      log('请在浏览器中扫码登录微信视频号...')
      await page.waitForURL('**/post/**', { timeout: 120000 })
      log('登录成功')
      await page.waitForTimeout(2000)
    }

    await page.screenshot({ path: path.join(DEBUG_DIR, 'wx_01_page.png'), fullPage: true })

    // ── 上传视频 ──
    log('上传视频文件...')
    const fileInputs = await page.$$('input[type="file"]')
    log(`找到 ${fileInputs.length} 个文件上传input`)

    if (fileInputs.length > 0) {
      await fileInputs[0].setInputFiles(videoPath)
      log('视频上传中...')
    } else {
      log('未找到文件上传input')
    }

    // 等待上传完成
    log('等待视频上传（最多5分钟）...')
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(5000)
      const progress = await page.$('[class*="progress"], [class*="uploading"], [class*="loading"]')
      const success = await page.$('[class*="success"], [class*="complete"], video[src]')
      if (!progress || success) {
        log('视频上传完成')
        break
      }
      log(`上传中... ${i * 5 + 5}秒`)
    }

    await page.waitForTimeout(3000)
    await page.screenshot({ path: path.join(DEBUG_DIR, 'wx_02_upload.png'), fullPage: true })

    // ── 上传封面 ──
    if (coverPath) {
      log('上传自定义封面...')
      await page.waitForTimeout(1000)

      // 点击封面区域
      const coverSelectors = ['text=上传封面', 'text=选择封面', '[class*="cover"]', '[class*="poster"]']
      for (const sel of coverSelectors) {
        const el = await page.$(sel)
        if (el) {
          try {
            await el.click()
            log(`点击封面: ${sel}`)
            await page.waitForTimeout(1500)
            break
          } catch {}
        }
      }

      const imgInputs = await page.$$('input[type="file"][accept*="image"], input[accept*="jpg"], input[accept*="png"]')
      log(`找到 ${imgInputs.length} 个图片上传input`)
      if (imgInputs.length > 0) {
        await imgInputs[0].setInputFiles(coverPath)
        log('封面已上传')
        await page.waitForTimeout(2000)
      }
    }

    await page.screenshot({ path: path.join(DEBUG_DIR, 'wx_03_cover.png'), fullPage: true })

    // ── 填写标题 ──
    log('填写标题...')
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
        log(`标题已填写: ${title}`)
        break
      }
    }

    // ── 填写描述 ──
    log('填写描述...')
    const intro = description + (hashtags.length > 0
      ? '\n' + hashtags.slice(0, 5).map(t => `#${t}`).join(' ')
      : '')

    const descSelectors = [
      'textarea[placeholder*="描述"]',
      'textarea[placeholder*="简介"]',
      'textarea[placeholder*="内容"]',
      '[class*="desc"] textarea',
      'textarea'
    ]
    for (const sel of descSelectors) {
      const el = await page.$(sel)
      if (el) {
        await el.click()
        await page.keyboard.press('Control+A')
        await page.keyboard.press('Backspace')
        await el.type(intro, { delay: 50 })
        log('描述已填写')
        break
      }
    }

    await page.screenshot({ path: path.join(DEBUG_DIR, 'wx_04_filled.png'), fullPage: true })

    log('请在浏览器中检查内容，确认后手动点击发布')
    log('调试截图已保存到: ' + DEBUG_DIR)
    log('等待你关闭浏览器窗口...')
    await page.waitForEvent('close', { timeout: 600000 })

  } catch (e) {
    log(`出错: ${e.message}`)
    await page.screenshot({ path: path.join(DEBUG_DIR, 'wx_error.png'), fullPage: true })
    log('请手动完成发布后关闭浏览器')
    await page.waitForEvent('close', { timeout: 600000 })
  }

  await browser.close().catch(() => {})
}

module.exports = { publish }

"""
步骤1：抖音链接 → 下载视频 → faster-whisper 转录文案
从 session.json 读取 url，将 raw_transcript 写回 session.json
"""
import os
import re
import sys
import asyncio
import subprocess
from datetime import datetime
from urllib.parse import urlparse

# 清理 sys.path，防止 StepFun 等路径冲突
sys.path = [p for p in sys.path if 'StepFun' not in p]

# douyin-downloader 路径必须在其他 import 之前加入（通过 VF_DOWNLOADER 环境变量或设置传入）
_downloader = os.environ.get("VF_DOWNLOADER", "")
if _downloader and _downloader not in sys.path:
    sys.path.insert(0, _downloader)

from vf_utils import log, done, error, read_session, update_session, get_env


def get_proxy():
    """读取 Windows 系统代理（环境变量优先，其次注册表）"""
    proxy = os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy")
    if proxy:
        return proxy
    # 读注册表
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                             r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        try:
            enable, _ = winreg.QueryValueEx(key, "ProxyEnable")
            if enable:
                server, _ = winreg.QueryValueEx(key, "ProxyServer")
                # aiohttp 需要 http:// 前缀
                if server and not server.startswith("http"):
                    server = f"http://{server}"
                return server
        finally:
            winreg.CloseKey(key)
    except Exception:
        pass
    return None


def get_cookies():
    import rookiepy
    for fn in [rookiepy.chrome, rookiepy.edge]:
        try:
            raw = fn(domains=[".douyin.com"])
            cdict = {c["name"]: c["value"] for c in raw}
            if cdict:
                return cdict
        except Exception:
            continue
    error("无法从浏览器获取抖音 cookies，请先用 Chrome/Edge 登录 douyin.com")


def extract_url(text: str) -> str:
    m = re.search(r'https?://v\.douyin\.com/[^\s]+', text)
    if m:
        return m.group(0).rstrip('/')
    m = re.search(r'https?://www\.douyin\.com/video/\d+', text)
    if m:
        return m.group(0)
    return None


async def download_video(url: str, temp_dir: str):
    from core.api_client import DouyinAPIClient
    cookies = get_cookies()
    os.makedirs(temp_dir, exist_ok=True)

    # 优先读环境变量，其次读 Windows 系统代理
    proxy = get_proxy()

    async with DouyinAPIClient(cookies, proxy=proxy) as api:
        if "v.douyin.com" in url:
            session = await api.get_session()
            async with session.get(url, allow_redirects=True, proxy=proxy) as resp:
                real_url = str(resp.url)
            log(f"真实链接: {real_url}")
        else:
            real_url = url

        m = re.search(r'/video/(\d+)', real_url)
        if not m:
            m = re.search(r'modal_id=(\d+)', real_url)
        if not m:
            error(f"无法提取视频ID: {real_url}")
        aweme_id = m.group(1)

        detail = await api.get_video_detail(aweme_id)
        if not detail:
            error("获取视频详情失败，可能需要更新 cookies")

        title = detail.get("desc", aweme_id)
        author = detail.get("author", {}).get("nickname", "未知")
        log(f"视频: {author}: {title}")

        video = detail.get("video", {})
        play_addr = video.get("play_addr", {})
        url_list = [u for u in (play_addr.get("url_list") or []) if u]
        url_list.sort(key=lambda u: 0 if "watermark=0" in u else 1)

        ua = api.headers["User-Agent"]
        dl_headers = {
            "Referer": "https://www.douyin.com/",
            "Origin": "https://www.douyin.com",
            "User-Agent": ua,
        }

        video_url = None
        for candidate in url_list:
            parsed = urlparse(candidate)
            if parsed.netloc.endswith("douyin.com"):
                if "X-Bogus=" not in candidate:
                    signed_url, signed_ua = api.sign_url(candidate)
                    dl_headers["User-Agent"] = signed_ua
                    video_url = signed_url
                else:
                    video_url = candidate
            else:
                video_url = candidate
            break

        if not video_url:
            uri = play_addr.get("uri") or video.get("vid")
            if uri:
                params = {"video_id": uri, "ratio": "1080p", "line": "0",
                          "is_play_url": "1", "watermark": "0",
                          "source": "PackSourceEnum_PUBLISH"}
                video_url, signed_ua = api.build_signed_path("/aweme/v1/play/", params)
                dl_headers["User-Agent"] = signed_ua

        if not video_url:
            error("无法获取视频下载地址")

        video_path = os.path.join(temp_dir, f"{aweme_id}.mp4")
        session = await api.get_session()
        log("正在下载视频...")

        # 重试下载，最多3次
        for attempt in range(3):
            try:
                async with session.get(video_url, headers=dl_headers) as resp:
                    if resp.status != 200:
                        error(f"下载失败: HTTP {resp.status}")
                    with open(video_path, 'wb') as f:
                        async for chunk in resp.content.iter_chunked(8192):
                            f.write(chunk)
                break
            except Exception as e:
                if attempt < 2:
                    log(f"下载中断，重试中... ({attempt + 2}/3)")
                    await asyncio.sleep(2)
                else:
                    raise e

        size_mb = os.path.getsize(video_path) / 1024 / 1024
        log(f"视频已下载: {size_mb:.1f}MB")
        return video_path, title, author


def transcribe(video_path: str, skip_cleanup: bool = False) -> str:
    audio_path = video_path.replace(".mp4", ".wav")

    # 如果音频已存在且是复用模式，直接转录
    if not skip_cleanup or not os.path.exists(audio_path):
        log("提取音频...")
        subprocess.run(
            ["ffmpeg", "-y", "-i", video_path, "-vn", "-ar", "16000", "-ac", "1",
             "-acodec", "pcm_s16le", audio_path],
            capture_output=True, check=True
        )

    log("加载语音识别模型（GPU 加速）...")
    from faster_whisper import WhisperModel
    model = WhisperModel("base", device="cuda", compute_type="float16")
    segments, info = model.transcribe(audio_path, language="zh")
    text = "".join([seg.text for seg in segments])
    log(f"转录完成，共 {len(text)} 字")

    # 清理临时文件（复用模式不清理）
    if not skip_cleanup:
        for f in [video_path, audio_path]:
            try:
                os.remove(f)
            except Exception:
                pass

    return text


def run(session_path: str):
    try:
        session = read_session(session_path)
        url = session.get("url", "")
        if not url:
            error("session 中未找到 url")

        # 1. 如果已有文案，直接返回
        existing = session.get("extract", {})
        if existing.get("raw_transcript"):
            log("已存在文案，跳过提取")
            done("raw_transcript", existing["raw_transcript"])
            return

        clean_url = extract_url(url) or url
        temp_dir = os.path.join(os.path.dirname(session_path), "tmp")

        # 从 URL 提取 aweme_id 用于缓存文件名
        m = re.search(r'/video/(\d+)', clean_url)
        if not m:
            m = re.search(r'modal_id=(\d+)', clean_url)
        aweme_id = m.group(1) if m else "video"

        video_path = os.path.join(temp_dir, f"{aweme_id}.mp4")
        audio_path = os.path.join(temp_dir, f"{aweme_id}.wav")

        # 2. 如果已有音频，直接转录
        if os.path.exists(audio_path):
            log(f"复用已有音频: {audio_path}")
            transcript = transcribe(audio_path, skip_cleanup=True)
            update_session(session_path, {
                "extract": {
                    "raw_transcript": transcript,
                    "video_title": existing.get("video_title", aweme_id),
                    "author": existing.get("author", "未知"),
                    "status": "done"
                }
            })
            done("raw_transcript", transcript)
            return

        # 3. 如果已有视频，提取音频后转录
        if os.path.exists(video_path):
            log(f"复用已有视频: {video_path}")
            title = existing.get("video_title", aweme_id)
            author = existing.get("author", "未知")
        else:
            # 4. 下载视频
            log(f"开始处理: {clean_url}")
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                video_path, title, author = loop.run_until_complete(
                    download_video(clean_url, temp_dir)
                )
            finally:
                loop.close()

        transcript = transcribe(video_path)

        log(f"正在保存文案到 session...")
        update_session(session_path, {
            "extract": {
                "raw_transcript": transcript,
                "video_title": title,
                "author": author,
                "status": "done"
            }
        })
        log("文案已保存")
        done("raw_transcript", transcript)
    except Exception as e:
        import traceback
        log(f"提取失败: {e}")
        traceback.print_exc()
        error(str(e))

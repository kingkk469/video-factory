"""
步骤5：HeyGen API 生成数字人视频
"""
import os
import time
import requests
from vf_utils import log, done, error, read_session, update_session, get_env


def run(session_path: str):
    session = read_session(session_path)
    out_dir = os.path.dirname(session_path)
    video_path = os.path.join(out_dir, "output.mp4")

    # 1. 检查是否已有视频
    if os.path.exists(video_path):
        log(f"复用已有视频: {video_path}")
        size_mb = os.path.getsize(video_path) / 1024 / 1024
        update_session(session_path, {
            "video": {
                "video_path": video_path,
                "video_url": session.get("video", {}).get("video_url", ""),
                "avatar_id": session.get("videoConfig", {}).get("avatarId", get_env("VF_HEYGEN_AVATAR", "")),
                "status": "done"
            }
        })
        done("video_path", video_path)
        return

    audio_data = session.get("audio", {})
    audio_path = audio_data.get("audio_path", "")
    if not audio_path or not os.path.exists(audio_path):
        error("未找到��音文件，请先完成配音步骤")

    api_key = get_env("VF_HEYGEN_KEY")
    video_cfg = session.get("videoConfig", {})
    avatar_id = video_cfg.get("avatarId", "") or get_env("VF_HEYGEN_AVATAR")
    if not api_key:
        error("未配置 HeyGen API Key，请在设置中填写")
    if not avatar_id:
        error("未配置 HeyGen Avatar ID，请在设置中填写")

    proxy = get_env("HTTP_PROXY") or get_env("HTTPS_PROXY") or None
    proxies = {"http": proxy, "https": proxy} if proxy else None

    # 1. 上传音频
    log("上传音频到 HeyGen...")
    with open(audio_path, "rb") as f:
        audio_bytes = f.read()
    resp = requests.post(
        "https://upload.heygen.com/v1/asset",
        headers={
            "X-Api-Key": api_key,
            "Content-Type": "audio/mpeg",
        },
        data=audio_bytes,
        timeout=120,
        proxies=proxies
    )
    log(f"上传响应: {resp.status_code} {resp.text[:200]}")
    resp.raise_for_status()
    data = resp.json()
    asset_id = data.get("data", {}).get("id") or data.get("id")
    if not asset_id:
        error(f"上传音频失败: {data}")
    log(f"音频上传成功: {asset_id}")

    # 2. 创建视频任务
    log("提交数字人视频生成任务...")
    resp = requests.post(
        "https://api.heygen.com/v2/video/generate",
        headers={"X-Api-Key": api_key, "Content-Type": "application/json"},
        json={
            "video_inputs": [{
                "character": {
                    "type": "avatar",
                    "avatar_id": avatar_id,
                    "avatar_style": "normal"
                },
                "voice": {
                    "type": "audio",
                    "audio_asset_id": asset_id
                }
            }],
            "dimension": {"width": 1080, "height": 1920}
        },
        timeout=30,
        proxies=proxies
    )
    resp.raise_for_status()
    data = resp.json()
    video_id = data.get("data", {}).get("video_id") or data.get("video_id")
    if not video_id:
        error(f"创建视频任务失败: {data}")
    log(f"任务已提交，video_id: {video_id}")

    # 3. 轮询状态（带网络重试）
    log("等待视频生成（约2-10分钟）...")
    poll_count = 0
    max_retries = 3  # 每次轮询最多重试3次
    while True:
        time.sleep(10)
        poll_count += 1

        # 带重试的网络请求
        last_error = None
        for attempt in range(max_retries):
            try:
                resp = requests.get(
                    "https://api.heygen.com/v1/video_status.get",
                    headers={"X-Api-Key": api_key},
                    params={"video_id": video_id},
                    timeout=60,
                    proxies=proxies
                )
                resp.raise_for_status()
                data = resp.json().get("data", {})
                status = data.get("status")
                log(f"状态: {status} (轮询第{poll_count}次)")
                last_error = None
                break  # 成功，跳出重试循环
            except Exception as e:
                last_error = str(e)
                if attempt < max_retries - 1:
                    log(f"网络错误，10秒后重试... ({attempt + 1}/{max_retries})")
                    time.sleep(10)
                else:
                    log(f"网络错误已达最大重试次数: {last_error}")

        if last_error:
            # 网络仍然不通，询问用户是否继续等待
            log(f"警告：无法连接 HeyGen API，视频可能仍在生成中")
            log(f"你可以在 HeyGen 网站上手动下载视频，video_id: {video_id}")
            # 继续等待，下一轮会再试
            continue

        if status == "completed":
            video_url = data.get("video_url")
            if not video_url:
                error("视频生成完成但未返回下载链接")
            break
        elif status in ("failed", "error"):
            error(f"视频生成失败: {data}")

    # 4. 下载视频
    log("正在下载视频...")
    out_dir = os.path.dirname(session_path)
    video_path = os.path.join(out_dir, "output.mp4")
    r = requests.get(video_url, timeout=300, stream=True, proxies=proxies)
    r.raise_for_status()
    with open(video_path, "wb") as f:
        for chunk in r.iter_content(chunk_size=8192):
            f.write(chunk)

    size_mb = os.path.getsize(video_path) / 1024 / 1024
    log(f"视频已下载: {size_mb:.1f}MB")

    update_session(session_path, {
        "video": {
            "video_path": video_path,
            "video_url": video_url,
            "avatar_id": avatar_id,
            "status": "done"
        }
    })
    done("video_path", video_path)

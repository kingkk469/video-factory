#!/usr/bin/env python3
"""
手动下载 HeyGen 已生成的视频
用法：python download_video.py <video_id> <output_path>
"""
import sys
import os
import requests

# 从配置文件读取 API Key
import json
try:
    config_path = os.path.join(os.environ.get('APPDATA', ''), 'video-factory', 'config.json')
    with open(config_path, 'r', encoding='utf-8') as f:
        cfg = json.load(f)
    api_key = cfg.get('heygenApiKey', '')
    proxy = cfg.get('proxy', '')
except Exception as e:
    print(f"读取配置失败：{e}")
    api_key = os.environ.get('VF_HEYGEN_KEY', '')
    proxy = os.environ.get('HTTP_PROXY', '') or os.environ.get('HTTPS_PROXY', '')

if not api_key:
    print("错误：未配置 HeyGen API Key")
    sys.exit(1)

if len(sys.argv) < 3:
    print("用法：python download_video.py <video_id> <output_path>")
    sys.exit(1)

video_id = sys.argv[1]
output_path = sys.argv[2]

proxies = None
if proxy:
    proxies = {"http": proxy, "https": proxy}
    print(f"使用代理：{proxy}")
else:
    print("未使用代理（直连）")

# 1. 查询视频状态
print(f"查询视频状态：{video_id}")
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
video_url = data.get("video_url")

print(f"状态：{status}")

if status != "completed":
    print(f"视频尚未完成，当前状态：{status}")
    sys.exit(1)

if not video_url:
    print("错误：视频已完成但未返回下载链接")
    sys.exit(1)

print(f"下载链接：{video_url[:50]}...")

# 2. 下载视频
print("正在下载视频...")
r = requests.get(video_url, timeout=300, stream=True, proxies=proxies)
r.raise_for_status()

with open(output_path, "wb") as f:
    total = 0
    for chunk in r.iter_content(chunk_size=8192):
        f.write(chunk)
        total += len(chunk)
        if total % (1024 * 1024) < 8192:
            print(f"  已下载 {total / 1024 / 1024:.1f}MB", end="\r")

print(f"\n视频已下载：{output_path} ({total / 1024 / 1024:.1f}MB)")

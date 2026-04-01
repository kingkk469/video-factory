"""
步骤7：ffmpeg 合成最终视频（字幕 + 背景音乐）
"""
import os
import shutil
import subprocess
from vf_utils import log, done, error, read_session, update_session, safe_path


def hex_to_ass(hex_str):
    """Convert RGB hex (RRGGBB) to ASS colour AABBGGRR (no &H& wrappers)"""
    h = hex_str.lstrip("#")
    if len(h) != 6:
        return "00FFFFFF"
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"00{b}{g}{r}".upper()


def srt_time_to_sec(t):
    """Convert SRT timestamp 'HH:MM:SS,mmm' to float seconds"""
    h, m, rest = t.split(':')
    s, ms = rest.split(',')
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def run(session_path: str):
    import json as _json
    session = read_session(session_path)
    # 打印完整 session，便于调试 bgmPath
    log(f"[edit] session.json:\n{_json.dumps(session, ensure_ascii=False)}")
    # 始终使用原始数字人视频作为输入，避免在已合成的视频上重复叠加 BGM/字幕
    video_path = session.get("video", {}).get("video_path", "")
    if not video_path or not os.path.exists(video_path):
        error("未找到视频文件，请先完成视频生成步骤")

    cfg = session.get("editConfig", {})
    bgm_path = cfg.get("bgmPath", "")
    log(f"[edit] bgmPath from session: {bgm_path!r}")
    log(f"[edit] bgm exists: {os.path.exists(bgm_path)}")
    subtitle_enable = cfg.get("subtitleEnable", True)
    voice_vol = cfg.get("voiceVol", 1.0)
    bgm_vol = cfg.get("bgmVol", 0.2)
    srt_path = session.get("subtitle", {}).get("srt_path", "")
    sub_color = cfg.get("subColor", "#FFFFFF")
    sub_stroke = cfg.get("subStroke", "#000000")
    sub_size = cfg.get("subSize", 24)
    font_name = cfg.get("subFont", "Microsoft YaHei")
    pip_list = [p for p in cfg.get("pip", []) if p.get("videoPath") and os.path.exists(p["videoPath"])]

    session_dir = os.path.dirname(session_path)
    tmp_out = os.path.join(session_dir, "final_new.mp4")

    # ── 构建 filter_complex ──────────────────────────────────────────
    filters = []
    video_path = safe_path(video_path, session_dir)
    inputs = ["-i", video_path]
    v_out = "0:v"
    a_out = "0:a"
    input_idx = 1

    # 背景音乐混入
    has_bgm = bgm_path and os.path.exists(bgm_path)
    if has_bgm:
        bgm_copied = safe_path(bgm_path, session_dir)
        inputs += ["-i", bgm_copied]
        log(f"[edit] BGM 已复制到: {bgm_copied}")
        log(f"[edit] 混音参数: voice_vol={voice_vol}, bgm_vol={bgm_vol}")
        filters.append(
            f"[{a_out}]volume={voice_vol}[voice];[{input_idx}:a]volume={bgm_vol}[bgm];"
            f"[voice][bgm]amix=inputs=2:duration=first:normalize=0[aout]"
        )
        a_out = "[aout]"
        input_idx += 1

    # 画中画：视频替换
    if pip_list:
        log(f"画中画：共 {len(pip_list)} 段替换视频")
        for i, pip in enumerate(pip_list):
            pip_input_idx = input_idx
            pip_video_path = safe_path(pip["videoPath"], session_dir)
            inputs += ["-i", pip_video_path]
            input_idx += 1

            start = srt_time_to_sec(pip["start"])
            end = srt_time_to_sec(pip["end"])
            duration = end - start
            tag_scaled = f"pip_s{i}"
            tag_out = f"pip_v{i}"

            # 获取原视频分辨率来缩放替换视频，并裁剪到对应时长
            filters.append(
                f"[{pip_input_idx}:v]scale=1080:1920:force_original_aspect_ratio=decrease,"
                f"pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setpts=PTS-STARTPTS,"
                f"trim=duration={duration:.3f},setpts=PTS-STARTPTS[{tag_scaled}]"
            )
            # overlay: 在 start~end 时间段内完全覆盖原画面
            filters.append(
                f"[{v_out}][{tag_scaled}]overlay=0:0:"
                f"enable='between(t,{start:.3f},{end:.3f})'[{tag_out}]"
            )
            v_out = tag_out
            log(f"  段{i+1}: {pip['start']} ~ {pip['end']} -> {pip_video_path}")

    # 字幕烧录
    if subtitle_enable and srt_path and os.path.exists(srt_path):
        # 中文路径复制到 session 目录，避免 ffmpeg 读取时乱码
        srt_path = safe_path(srt_path, session_dir)
        # 字幕路径需要转为 Linux 风格 /，并处理 ffmpeg 的 escape
        srt_esc = srt_path.replace("\\", "/").replace(":", "\\:")
        style = (
            f"FontName={font_name},"
            f"FontSize={sub_size},"
            f"PrimaryColour=&H{hex_to_ass(sub_color)}&,"
            f"OutlineColour=&H{hex_to_ass(sub_stroke)}&,"
            f"Outline=2,Bold=1,Alignment=2,MarginV=30"
        )
        filters.append(f"[{v_out}]subtitles='{srt_esc}':force_style='{style}'[vout]")
        v_out = "[vout]"
        log(f"字幕样式: {style}")
    else:
        if subtitle_enable:
            log(f"字幕文件不存在或未启用，跳过字幕烧录（srt_path={srt_path!r}）")

    # ── 组装命令 ─────────────────────────────────────────────────────
    cmd = ["ffmpeg", "-y"] + inputs
    if filters:
        cmd += ["-filter_complex", ";".join(filters)]
    cmd += ["-map", v_out, "-map", a_out]
    cmd += ["-c:v", "libx264", "-c:a", "aac", tmp_out]

    log("合成最终视频...")
    log(f"命令: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        error(f"ffmpeg 失败: {result.stderr[-800:]}")

    # 原子替换 final.mp4
    final_path = os.path.join(session_dir, "final.mp4")
    if os.path.exists(final_path):
        os.remove(final_path)
    shutil.move(tmp_out, final_path)
    out_path = final_path

    size_mb = os.path.getsize(out_path) / 1024 / 1024
    log(f"合成完成: {out_path}（{size_mb:.1f}MB）")
    update_session(session_path, {"edit": {"output_path": out_path, "status": "done"}})
    done("output_path", out_path)

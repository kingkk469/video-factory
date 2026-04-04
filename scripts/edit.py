"""
步骤7：ffmpeg 合成最终视频（字幕 + 背景音乐）
"""
import os
import shutil
import time
import subprocess
from vf_utils import log, done, error, read_session, update_session, safe_path


def ms_str_to_ass(ts):
    """Convert either 'HH:MM:SS,mmm' or raw milliseconds string to ASS time 'H:MM:SS.cc'"""
    ts = ts.strip()
    if ':' in ts:
        # HH:MM:SS,mmm
        h, m, rest = ts.split(':')
        s, ms = rest.replace(',', '.').split('.')
        total_ms = int(h)*3600000 + int(m)*60000 + int(s)*1000 + int(ms[:3])
    else:
        total_ms = int(ts)
    h = total_ms // 3600000
    m = (total_ms % 3600000) // 60000
    s = (total_ms % 60000) // 1000
    cs = (total_ms % 1000) // 10
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def srt_to_ass(srt_path, ass_path, font_name, font_size, color_ass, outline_ass, margin_v=30,
               shadow_color_ass="00000000", shadow_dist=2, shadow_angle=135, outline_width=2):
    """Convert SRT to ASS with embedded style, avoiding libass Windows path issues."""
    import re, math
    with open(srt_path, encoding="utf-8") as f:
        srt = f.read()

    # Parse SRT blocks
    blocks = re.split(r'\n\s*\n', srt.strip())
    events = []
    for block in blocks:
        lines = block.strip().splitlines()
        if len(lines) < 3:
            continue
        ts = lines[1]
        m = re.match(r'(\S+)\s*-->\s*(\S+)', ts)
        if not m:
            continue
        start = ms_str_to_ass(m.group(1))
        end = ms_str_to_ass(m.group(2))
        text = '\\N'.join(lines[2:])
        events.append(f"Dialogue: 0,{start},{end},Default,,0,0,0,,{text}")

    # 阴影颜色通过 per-event \4c tag 注入，距离和角度通过 \xshad\yshad
    # 同时 Style Shadow 字段设为 shadow_dist，确保 libass 启用阴影渲染
    rad = math.radians(shadow_angle)
    xshad = round(shadow_dist * math.cos(rad), 1)
    yshad = round(shadow_dist * math.sin(rad), 1)
    # 阴影透明时不注入 tag，避免覆盖 Style 默认值
    shadow_alpha = int(shadow_color_ass[:2], 16) if len(shadow_color_ass) >= 2 else 0
    use_shadow = shadow_dist > 0 and shadow_alpha < 255
    shadow_tag = f"{{\\xshad{xshad}\\yshad{yshad}\\4c&H{shadow_color_ass}&}}" if use_shadow else ""

    events_with_shadow = []
    for e in events:
        parts = e.split(',,', 1)
        if len(parts) == 2:
            events_with_shadow.append(parts[0] + ',,' + shadow_tag + parts[1])
        else:
            events_with_shadow.append(e)

    style_shadow = round(shadow_dist, 1) if use_shadow else 0

    ass = f"""[Script Info]
ScriptType: v4.00+
PlayResX: 384
PlayResY: 288

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,{font_name},{font_size},&H{color_ass}&,&H{color_ass}&,&H{outline_ass}&,&H00000000&,1,0,0,0,100,100,0,0,1,{outline_width},{style_shadow},2,10,10,{margin_v},1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
""" + "\n".join(events_with_shadow) + "\n"

    with open(ass_path, "w", encoding="utf-8") as f:
        f.write(ass)


def hex_to_ass(hex_str):
    """Convert RGB hex (RRGGBB) to ASS colour AABBGGRR (no &H& wrappers)"""
    h = hex_str.lstrip("#")
    if len(h) != 6:
        return "00FFFFFF"
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"00{b}{g}{r}".upper()


def hex_to_ass_with_alpha(hex_str, opacity_pct):
    """Convert RGB hex + opacity (0-100) to ASS colour AABBGGRR"""
    h = hex_str.lstrip("#")
    if len(h) != 6:
        h = "000000"
    r, g, b = h[0:2], h[2:4], h[4:6]
    alpha = int((1 - opacity_pct / 100) * 255)
    return f"{alpha:02X}{b}{g}{r}".upper()


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
    sub_stroke_enable = cfg.get("subStrokeEnable", True)
    sub_stroke = cfg.get("subStroke", "#000000") if sub_stroke_enable else "#000000"
    sub_size = cfg.get("subSize", 24)
    font_name = cfg.get("subFont", "Microsoft YaHei")
    sub_shadow_enable = cfg.get("subShadowEnable", True)
    shadow_color = cfg.get("subShadowColor", "#000000")
    shadow_opacity = cfg.get("subShadowOpacity", 80) if sub_shadow_enable else 0
    shadow_angle = cfg.get("subShadowAngle", 135)
    shadow_dist = cfg.get("subShadowDist", 2)
    pip_list = [p for p in cfg.get("pip", []) if p.get("videoPath") and os.path.exists(p["videoPath"])]

    session_dir = os.path.dirname(session_path)
    final_path = os.path.join(session_dir, "final.mp4")
    tmp_out = os.path.join(session_dir, "final_new.mp4")
    # 合成前删除旧的 final.mp4，避免 ffmpeg 输出时被占用
    if os.path.exists(final_path):
        for attempt in range(20):
            try:
                os.remove(final_path)
                break
            except PermissionError:
                time.sleep(0.5)

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

    # 画中画：视频/图片替换
    if pip_list:
        log(f"画中画：共 {len(pip_list)} 段替换")
        mute_filters = []

        def make_crop_filter(src_tag, dst_tag, crop_top, crop_bottom, crop_left, crop_right):
            if crop_top == 0 and crop_bottom == 0 and crop_left == 0 and crop_right == 0:
                return None, src_tag
            cw = f"iw*(1-{crop_left/100:.4f}-{crop_right/100:.4f})"
            ch = f"ih*(1-{crop_top/100:.4f}-{crop_bottom/100:.4f})"
            cx = f"iw*{crop_left/100:.4f}"
            cy = f"ih*{crop_top/100:.4f}"
            return f"[{src_tag}]crop={cw}:{ch}:{cx}:{cy}[{dst_tag}_cropped]", f"{dst_tag}_cropped"

        for i, pip in enumerate(pip_list):
            pip_input_idx = input_idx
            pip_file_path = safe_path(pip["videoPath"], session_dir)
            is_image = pip_file_path.lower().endswith(('.jpg', '.jpeg', '.png', '.gif', '.webp'))

            start = srt_time_to_sec(pip["start"])
            end = srt_time_to_sec(pip["end"])
            duration = end - start

            # 素材时间裁剪
            src_start = pip.get("srcStart", 0) or 0
            src_end = pip.get("srcEnd", None)
            src_duration = (src_end - src_start) if src_end else None

            # 位置和大小（百分比 -> 像素，基于 1080x1920）
            x_pct = pip.get("x", 0)
            y_pct = pip.get("y", 0)
            w_pct = pip.get("w", 100)
            h_pct = pip.get("h", 100)
            px_x = int(1080 * x_pct / 100)
            px_y = int(1920 * y_pct / 100)
            px_w = int(1080 * w_pct / 100)
            px_h = int(1920 * h_pct / 100)

            # 裁剪参数
            crop_top    = pip.get("cropTop", 0)
            crop_bottom = pip.get("cropBottom", 0)
            crop_left   = pip.get("cropLeft", 0)
            crop_right  = pip.get("cropRight", 0)

            tag_scaled = f"pip_s{i}"
            tag_out = f"pip_v{i}"

            if is_image:
                inputs += ["-i", pip_file_path]
                input_idx += 1
                crop_f, crop_tag = make_crop_filter(f"{pip_input_idx}:v", f"pip_c{i}", crop_top, crop_bottom, crop_left, crop_right)
                if crop_f:
                    filters.append(crop_f)
                # loop=-1 无限循环，trim 截取所需时长，fps=25 生成视频流
                filters.append(
                    f"[{crop_tag}]scale={px_w}:{px_h},"
                    f"fps=25,loop=-1:size=1:start=0,"
                    f"trim=duration={duration:.3f},setpts=PTS-STARTPTS+{start:.3f}/TB[{tag_scaled}]"
                )
            else:
                inputs += ["-stream_loop", "-1", "-i", pip_file_path]
                input_idx += 1
                crop_f, crop_tag = make_crop_filter(f"{pip_input_idx}:v", f"pip_c{i}", crop_top, crop_bottom, crop_left, crop_right)
                if crop_f:
                    filters.append(crop_f)
                trim_part = f"trim=start={src_start:.3f}:duration={pip_duration if (pip_duration := (src_duration if src_duration else duration)) else duration:.3f}"
                filters.append(
                    f"[{crop_tag}]fps=25,{trim_part},setpts=PTS-STARTPTS+{start:.3f}/TB,"
                    f"scale={px_w}:{px_h}:force_original_aspect_ratio=decrease,"
                    f"pad={px_w}:{px_h}:(ow-iw)/2:(oh-ih)/2[{tag_scaled}]"
                )

            filters.append(
                f"[{v_out}][{tag_scaled}]overlay={px_x}:{px_y}:"
                f"enable='between(t,{start:.3f},{end:.3f})'[{tag_out}]"
            )
            v_out = tag_out
            log(f"  段{i+1}: {pip['start']} ~ {pip['end']} pos=({px_x},{px_y}) size={px_w}x{px_h} -> {pip_file_path}")

            if pip.get("coverBgm"):
                mute_filters.append(f"between(t,{start:.3f},{end:.3f})")

        # 静音处理
        if mute_filters:
            mute_expr = "+".join(mute_filters)
            cur_a = a_out
            filters.append(
                f"[{cur_a}]volume=enable='{mute_expr}':volume=0[amuted]"
            )
            a_out = "[amuted]"

    # 字幕烧录
    if subtitle_enable and srt_path and os.path.exists(srt_path):
        # 如果 pipSegments 有编辑过的字幕，用它重建 SRT
        pip_segments = cfg.get("pipSegments") or session.get("pipSegments")
        if pip_segments:
            edited_srt = ""
            for i, seg in enumerate(pip_segments, 1):
                edited_srt += f"{i}\n{seg['start']} --> {seg['end']}\n{seg['text']}\n\n"
            edited_path = os.path.join(session_dir, "subtitle_edited.srt")
            with open(edited_path, "w", encoding="utf-8") as f:
                f.write(edited_srt)
            srt_path = edited_path
        else:
            # 中文路径复制到 session 目录，避免 ffmpeg 读取时乱码
            srt_path = safe_path(srt_path, session_dir)
        # 去掉字幕文字中的标点符号（只处理文字行，不动时间戳行）
        import re
        with open(srt_path, encoding="utf-8") as f:
            srt_content = f.read()
        def strip_punct_text_only(srt):
            lines = srt.splitlines(keepends=True)
            result = []
            for line in lines:
                # 时间戳行：包含 --> 的行，不处理
                if '-->' in line:
                    result.append(line)
                # 序号行：纯数字行，不处理
                elif line.strip().isdigit():
                    result.append(line)
                else:
                    result.append(re.sub(r'[，。！？、；：""''「」【】《》…—～·,.!?;:\'"()\[\]{}]', '', line))
            return ''.join(result)
        srt_clean = strip_punct_text_only(srt_content)
        clean_path = os.path.join(session_dir, "subtitle_clean.srt")
        with open(clean_path, "w", encoding="utf-8") as f:
            f.write(srt_clean)
        srt_path = clean_path
        # 将 SRT 转为 ASS，用 ass filter 规避 Windows 路径问题
        ass_path = os.path.join(session_dir, "subtitle_clean.ass")
        margin_v = cfg.get("subMarginV", 30)
        srt_to_ass(clean_path, ass_path, font_name, sub_size,
                   hex_to_ass(sub_color),
                   hex_to_ass(sub_stroke) if sub_stroke_enable else "00000000",
                   margin_v,
                   shadow_color_ass=hex_to_ass_with_alpha(shadow_color, shadow_opacity),
                   shadow_dist=shadow_dist, shadow_angle=shadow_angle,
                   outline_width=2 if sub_stroke_enable else 0)
        # ass filter 路径：盘符冒号转义为 \:
        ass_esc = ass_path.replace("\\", "/").replace(":", "\\:")
        filters.append(f"[{v_out}]ass='{ass_esc}'[vout]")
        v_out = "[vout]"
        log(f"字幕 ASS: {ass_path}")
    else:
        if subtitle_enable:
            log(f"字幕文件不存在或未启用，跳过字幕烧录（srt_path={srt_path!r}）")

    # ── 组装命令 ─────────────────────────────────────────────────────
    cmd = ["ffmpeg", "-y"] + inputs
    if filters:
        cmd += ["-filter_complex", ";".join(filters)]
    cmd += ["-map", v_out, "-map", a_out]
    cmd += ["-c:v", "libx264", "-c:a", "aac", final_path]

    log("合成最终视频...")
    log(f"命令: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=session_dir)
    if result.returncode != 0:
        error(f"ffmpeg 失败: {result.stderr[-800:]}")

    out_path = final_path

    size_mb = os.path.getsize(out_path) / 1024 / 1024
    log(f"合成完成: {out_path}（{size_mb:.1f}MB）")
    update_session(session_path, {"edit": {"output_path": out_path, "status": "done"}})
    done("output_path", out_path)

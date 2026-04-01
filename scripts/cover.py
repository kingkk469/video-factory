"""
封面生成：从视频截取背景帧，用 Pillow 生成多平台封面图
风格参考：抖音爆款封面 — 大字冲击、粗描边、副标题尾字对齐主标题
"""
import os
import subprocess
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from vf_utils import log, done, error, read_session, update_session


PLATFORM_SIZES = {
    "douyin":      (1080, 1920),
    "xiaohongshu": (1080, 1440),
    "weixin":      (1080, 1920),
}

# 字体查找顺序
FONT_CANDIDATES_BOLD = ["msyhbd.ttc", "msyh.ttc", "simhei.ttf", "arial.ttf"]
FONT_CANDIDATES_REG  = ["msyh.ttc", "simhei.ttf", "arial.ttf"]

# 系统字体名映射到候选文件（优先粗体版本）
FONT_NAME_MAP = {
    "Microsoft YaHei": ("msyhbd.ttc", "msyh.ttc"),
    "SimHei":          ("simhei.ttf", "simhei.ttf"),
    "KaiTi":           ("simkai.ttf", "simkai.ttf"),
    "SimSun":          ("simsun.ttc", "simsun.ttc"),
    "FangSong":        ("simfang.ttf", "simfang.ttf"),
    "YouYuan":         ("simyou.ttf", "simyou.ttf"),
}


def find_font(size, bold=True, font_name=None):
    """查找可用字体，font_name 指定时优先使用对应字体"""
    if font_name and font_name in FONT_NAME_MAP:
        bold_file, reg_file = FONT_NAME_MAP[font_name]
        candidates = [bold_file] if bold else [reg_file]
        for name in candidates:
            try:
                return ImageFont.truetype(name, size=size)
            except OSError:
                pass
    candidates = FONT_CANDIDATES_BOLD if bold else FONT_CANDIDATES_REG
    for name in candidates:
        try:
            return ImageFont.truetype(name, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def crop_center(img, tw, th):
    w, h = img.size
    scale = max(tw / w, th / h)
    img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    w, h = img.size
    return img.crop(((w - tw) // 2, (h - th) // 2,
                     (w - tw) // 2 + tw, (h - th) // 2 + th))


def smart_wrap(text, max_chars=6):
    """智能换行"""
    if len(text) <= max_chars:
        return [text]
    breaks = set("，。、！？；：,.!?;: ")
    lines, start = [], 0
    while start < len(text):
        end = min(start + max_chars, len(text))
        if end >= len(text):
            lines.append(text[start:])
            break
        best = -1
        for i in range(start + 2, end + 1):
            if i < len(text) and text[i] in breaks:
                best = i + 1
        if best > start:
            lines.append(text[start:best].strip())
            start = best
        else:
            lines.append(text[start:end])
            start = end
    return [l for l in lines if l]


def draw_stroked_text(draw, x, y, text, font, fill, stroke_fill=(0, 0, 0, 255),
                      stroke_width=6):
    """绘制粗描边文字 — 抖音风格的硬描边，清晰可读"""
    # 八方向描边
    for dx in range(-stroke_width, stroke_width + 1):
        for dy in range(-stroke_width, stroke_width + 1):
            if dx * dx + dy * dy <= stroke_width * stroke_width:
                draw.text((x + dx, y + dy), text, font=font, fill=stroke_fill)
    draw.text((x, y), text, font=font, fill=fill)


def measure_text(draw, text, font):
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def extract_frame(video_path, timestamp, out_path):
    cmd = ["ffmpeg", "-y", "-i", video_path, "-ss", str(timestamp),
           "-vframes", "1", "-q:v", "2", out_path]
    return subprocess.run(cmd, capture_output=True).returncode == 0


def hex_to_rgba(hex_color, alpha=255):
    """将 #RRGGBB 或 #RGB 格式的颜色字符串转为 RGBA tuple"""
    hex_color = hex_color.lstrip('#')
    if len(hex_color) == 3:
        hex_color = ''.join(c * 2 for c in hex_color)
    r = int(hex_color[0:2], 16)
    g = int(hex_color[2:4], 16)
    b = int(hex_color[4:6], 16)
    return (r, g, b, alpha)


def generate_cover(bg_frame, platform, main_title, sub_title="",
                   style="dark",
                   main_font=None, main_color=None, main_size=None, main_stroke_color=None,
                   sub_font=None, sub_color=None, sub_size=None, sub_stroke_color=None):
    """
    生成单个平台的封面图
    布局：
      - 主标题：居中偏上，超大字号，粗描边，单行
      - 副标题：单行，尾字对齐主标题尾字
    """
    w, h = PLATFORM_SIZES[platform]

    # ── 背景：轻度模糊（保留人物可见） ──
    bg = crop_center(bg_frame.copy(), w, h).filter(ImageFilter.GaussianBlur(2))
    bg = bg.convert("RGBA")

    # ── 轻度暗化（只加薄薄一层，不遮挡背景） ──
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ov_draw = ImageDraw.Draw(overlay)
    if style == "dark":
        for y_pos in range(h):
            r = y_pos / h
            if r < 0.08:
                a = int(60 + 80 * (r / 0.08))
            elif r < 0.45:
                a = 140
            elif r < 0.55:
                a = int(140 - 60 * ((r - 0.45) / 0.1))
            elif r < 0.82:
                a = 80
            else:
                a = int(80 + 80 * ((r - 0.82) / 0.18))
            ov_draw.line([(0, y_pos), (w, y_pos)], fill=(0, 0, 0, a))
    else:
        for y_pos in range(h):
            r = y_pos / h
            a = 100 if r < 0.45 or r > 0.82 else 50
            ov_draw.line([(0, y_pos), (w, y_pos)], fill=(255, 255, 255, a))

    bg = Image.alpha_composite(bg, overlay)
    draw = ImageDraw.Draw(bg)

    cx = w // 2

    # ── 主标题颜色（默认白/深色） ──
    default_main = (255, 255, 255, 255) if style == "dark" else (20, 20, 30, 255)
    main_fill = hex_to_rgba(main_color) if main_color else default_main
    main_stroke = hex_to_rgba(main_stroke_color) if main_stroke_color else (0, 0, 0, 255)

    # ── 副标题颜色（默认金黄） ──
    default_sub = (255, 210, 50, 255) if style == "dark" else (200, 130, 0, 255)
    sub_fill = hex_to_rgba(sub_color) if sub_color else default_sub
    sub_stroke = hex_to_rgba(sub_stroke_color) if sub_stroke_color else (0, 0, 0, 255)

    # ── 主标题（居中，超大字号，单行） ──
    title_len = len(main_title)
    if main_size:
        main_size_px = main_size
    elif title_len <= 4:
        main_size_px = 160
    elif title_len <= 6:
        main_size_px = 140
    elif title_len <= 10:
        main_size_px = 120
    else:
        main_size_px = 100

    font_main = find_font(main_size_px, bold=True, font_name=main_font)

    # 单行绘制
    tw, th = measure_text(draw, main_title, font_main)
    x_main = cx - tw // 2
    start_y = int(h * 0.12)

    draw_stroked_text(draw, x_main, start_y, main_title, font_main, main_fill,
                      stroke_fill=main_stroke, stroke_width=7)

    # 记录主标题右边界（用于副标题对齐）
    main_title_right_x = x_main + tw
    main_bottom = start_y + th

    # ── 副标题（单行，尾字对齐主标题尾字） ──
    if sub_title:
        sub_size_px = sub_size if sub_size else max(56, int(main_size_px * 0.6))
        font_sub = find_font(sub_size_px, bold=True, font_name=sub_font)

        sub_tw, sub_th = measure_text(draw, sub_title, font_sub)
        sub_start_y = main_bottom + int(main_size_px * 0.35)

        # 右对齐
        sub_x = main_title_right_x - sub_tw
        draw_stroked_text(draw, sub_x, sub_start_y, sub_title, font_sub, sub_fill,
                          stroke_fill=sub_stroke, stroke_width=5)

    return bg.convert("RGB")


def run(session_path: str):
    session = read_session(session_path)
    session_dir = os.path.dirname(session_path)

    video_path = (session.get("edit", {}).get("output_path") or
                  session.get("video", {}).get("video_path", ""))
    if not video_path or not os.path.exists(video_path):
        error("未找到视频文件")

    design = session.get("cover", {}).get("design", {})
    main_title = design.get("mainTitle", session.get("title", {}).get("title", ""))
    sub_title = design.get("subTitle", "")
    style = design.get("style", "dark")
    bg_timestamp = design.get("bgFrame", 2.5)
    # 主标题样式
    main_font   = design.get("mainFont", None) or None
    main_color  = design.get("mainColor", None) or None
    main_size   = design.get("mainSize", None)
    main_stroke = design.get("mainStroke", None) or None
    # 副标题样式
    sub_font   = design.get("subFont", None) or None
    sub_color  = design.get("subColor", None) or None
    sub_size   = design.get("subSize", None)
    sub_stroke = design.get("subStroke", None) or None
    if main_size: main_size = int(main_size)
    if sub_size:  sub_size  = int(sub_size)

    if not main_title:
        log("无标题信息，使用简单截图模式")
        out_path = os.path.join(session_dir, "cover.jpg")
        cmd = ["ffmpeg", "-y", "-i", video_path, "-ss", "00:00:01",
               "-vframes", "1", "-vf", "scale=720:-1", out_path]
        result = subprocess.run(cmd, capture_output=True)
        if result.returncode != 0:
            error("封面截取失败")
        update_session(session_path, {"cover": {"path": out_path, "status": "done"}})
        done("cover_path", out_path)
        return

    log(f"从视频 {bg_timestamp}s 处截取背景帧...")
    tmp_frame = os.path.join(session_dir, "_tmp_bg_frame.jpg")
    if not extract_frame(video_path, bg_timestamp, tmp_frame):
        error("背景帧截取失败")

    bg_frame = Image.open(tmp_frame)

    cover_data = {
        "status": "done",
        "design": {
            "mainTitle": main_title,
            "subTitle": sub_title,
            "style": style,
            "bgFrame": bg_timestamp,
            "mainFont": main_font,
            "mainColor": main_color,
            "mainSize": main_size,
            "mainStroke": main_stroke,
            "subFont": sub_font,
            "subColor": sub_color,
            "subSize": sub_size,
            "subStroke": sub_stroke,
        }
    }

    for platform in PLATFORM_SIZES:
        log(f"生成 {platform} 封面 ({PLATFORM_SIZES[platform][0]}x{PLATFORM_SIZES[platform][1]})...")
        cover = generate_cover(bg_frame, platform, main_title, sub_title, style,
                               main_font=main_font, main_color=main_color, main_size=main_size, main_stroke_color=main_stroke,
                               sub_font=sub_font, sub_color=sub_color, sub_size=sub_size, sub_stroke_color=sub_stroke)
        out_path = os.path.join(session_dir, f"cover_{platform}.jpg")
        cover.save(out_path, "JPEG", quality=95)
        cover_data[platform] = out_path
        log(f"{platform} 封面已保存: {out_path}")

    cover_data["path"] = cover_data["douyin"]

    try:
        os.remove(tmp_frame)
    except OSError:
        pass

    update_session(session_path, {"cover": cover_data})
    done("cover_path", cover_data["douyin"])

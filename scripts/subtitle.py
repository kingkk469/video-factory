"""
步骤6：用 faster-whisper 转录音频 + 改写文案断句，对齐时间戳
字幕文字 = 改写文案（按标点断句）
时间戳 = 音频转录结果
"""
import os
import re
from vf_utils import log, done, error, read_session, update_session


def ms_to_srt(ms):
    ms = int(ms)
    h = ms // 3600000
    m = (ms % 3600000) // 60000
    s = (ms % 60000) // 1000
    milli = ms % 1000
    return f"{h:02d}:{m:02d}:{s:02d},{milli:03d}"


def run(session_path: str):
    session = read_session(session_path)
    audio_path = session.get("audio", {}).get("audio_path", "")
    if not audio_path or not os.path.exists(audio_path):
        # 降级：用视频文件作为音频源
        audio_path = session.get("video", {}).get("video_path", "")
    if not audio_path or not os.path.exists(audio_path):
        error("未找到配音文件，请先完成配音步骤")

    rewrite_text = session.get("rewrite", {}).get("rewritten", "")
    if not rewrite_text:
        error("未找到改写文案，请先完成改写步骤")

    # 1. 用 faster-whisper 转录音频，获取词级时间戳
    log("加载 faster-whisper 模型...")
    from faster_whisper import WhisperModel
    model = WhisperModel("base", device="cuda", compute_type="float16")
    segments, info = model.transcribe(audio_path, language="zh", word_timestamps=True)
    total_duration = info.duration
    log(f"音频时长: {total_duration:.1f}秒")

    # 收集词级时间戳（秒为单位的 float）
    words = []
    for seg in segments:
        if seg.words:
            for w in seg.words:
                words.append((w.word.strip(), w.start, w.end))
        else:
            words.append((seg.text.strip(), seg.start, seg.end))

    if not words:
        error("whisper 未返回任何内容")

    # 拼接成纯文本
    asr_text = "".join([w[0] for w in words])
    log(f"ASR 文本: {asr_text}")

    # 2. 按标点将改写文案断句
    # 用前瞻分割：保留标点在句子末尾
    raw_parts = re.split(r'(?<=[，。、；：！？])', rewrite_text)
    sentences = []
    for part in raw_parts:
        part = part.strip()
        if not part or len(part) < 2:
            continue
        # 太长的再按字符均分（每句不超过 20 字）
        if len(part) > 20:
            for i in range(0, len(part), 20):
                chunk = part[i:i + 20].strip()
                if chunk:
                    sentences.append(chunk)
        else:
            sentences.append(part)

    log(f"改写文案断句: {len(sentences)} 句")
    for i, s in enumerate(sentences):
        log(f"  [{i+1}] {s}")

    # 3. 用 DP 序列对齐：将改写句子对齐到 ASR 词序列
    # 构建 ASR 字符序列
    asr_chars = list(asr_text)
    n_sent = len(sentences)
    n_chars = len(asr_chars)

    # char_sent[i] = 这句在 asr_chars 中的 [start, end) 索引
    char_sent = [None] * n_sent
    pos = 0
    # 清理改写文字中的空格
    sentences_clean = [s.replace(" ", "").replace("　", "") for s in sentences]

    for si, sent in enumerate(sentences_clean):
        sent_chars = list(sent)
        sent_len = len(sent_chars)
        if sent_len == 0:
            char_sent[si] = (pos, pos)
            continue

        # 在 asr_chars[pos:] 中找最佳匹配起点
        best_i = min(pos, max(0, n_chars - 1))
        best_score = -1

        # 搜索范围：从当前位置向后最多 sent_len*4+150 个字符
        search_start = max(0, pos - 10)
        search_end = min(n_chars, pos + sent_len * 4 + 150)

        for start_i in range(search_start, search_end):
            if start_i + sent_len > n_chars:
                break
            score = sum(
                1 for a, b in zip(asr_chars[start_i:start_i + sent_len], sent_chars)
                if a == b
            )
            if score > best_score:
                best_score = score
                best_i = start_i

        # 如果完全没有匹配，按比例估算位置（避免后续句子全部跳过）
        if best_score == 0:
            best_i = min(pos, n_chars - sent_len) if n_chars > sent_len else 0

        char_sent[si] = (best_i, best_i + sent_len)
        pos = best_i + sent_len

    # 4. 将字符索引映射回词级时间戳
    # 先把所有句子分成"ASR内匹配"和"溢出"两组
    # 构建 char_idx -> 时间 的映射（每个字符对应的词时间）
    char_to_time = []  # list of (start_s, end_s) per char position
    char_idx = 0
    for (w_text, w_s, w_e) in words:
        for _ in w_text:
            char_to_time.append((w_s, w_e))
        char_idx += len(w_text)
    # 补齐（防止 ce 超出）
    if char_to_time:
        while len(char_to_time) < n_chars:
            char_to_time.append(char_to_time[-1])

    srt_lines = []
    idx = 1
    prev_end_ms = 0
    last_valid_end_s = 0.0  # 最后一个有效 ASR 匹配的结束时间

    # 先处理 ASR 范围内的句子，记录最后有效时间
    entries = []  # list of (si, start_s, end_s, is_overflow)
    for si, (sent, (cs, ce)) in enumerate(zip(sentences, char_sent)):
        if cs >= ce:
            entries.append((si, None, None, True))
            continue
        cs_clamped = min(cs, len(char_to_time) - 1)
        ce_clamped = min(ce - 1, len(char_to_time) - 1)
        # 判断是否溢出（原始 cs 超过 ASR 文本长度）
        is_overflow = (cs >= n_chars)
        start_s = char_to_time[cs_clamped][0]
        end_s = char_to_time[ce_clamped][1]
        if not is_overflow:
            last_valid_end_s = end_s
        entries.append((si, start_s, end_s, is_overflow))

    # 找出溢出句子的数量，均匀分配剩余时间
    overflow_indices = [i for i, (si, s, e, ov) in enumerate(entries) if ov or s is None]
    if overflow_indices and total_duration > last_valid_end_s:
        remaining = total_duration - last_valid_end_s
        slot = remaining / len(overflow_indices)
        for k, ei in enumerate(overflow_indices):
            si = entries[ei][0]
            start_s = last_valid_end_s + k * slot
            end_s = last_valid_end_s + (k + 1) * slot
            entries[ei] = (si, start_s, end_s, True)

    for (si, start_s, end_s, is_overflow) in entries:
        if start_s is None:
            continue
        # 修正时间顺序
        if start_s >= end_s:
            end_s = start_s + 1.5
        # 填补小间隙
        if prev_end_ms > 0 and int(start_s * 1000) < prev_end_ms:
            start_s = prev_end_ms / 1000
        if start_s >= end_s:
            end_s = start_s + 0.5

        srt_lines.append(str(idx))
        srt_lines.append(f"{ms_to_srt(int(start_s * 1000))} --> {ms_to_srt(int(end_s * 1000))}")
        srt_lines.append(sentences[si])
        srt_lines.append("")

        prev_end_ms = int(end_s * 1000)
        idx += 1

    # 5. 最后一段延伸到音频结束
    if srt_lines and total_duration > 0:
        for i in range(len(srt_lines) - 1, -1, -1):
            if " --> " in srt_lines[i]:
                parts = srt_lines[i].split(" --> ")
                last_end = parse_srt_time(parts[1])
                audio_end = int(total_duration * 1000)
                if audio_end - last_end > 500:
                    srt_lines[i] = f"{parts[0]} --> {ms_to_srt(audio_end)}"
                break

    srt_path = os.path.join(os.path.dirname(session_path), "subtitle.srt")
    with open(srt_path, "w", encoding="utf-8") as f:
        f.write("\n".join(srt_lines))

    log(f"字幕已保存: {srt_path}，共 {idx - 1} 条")
    update_session(session_path, {"subtitle": {"srt_path": srt_path, "status": "done"}})
    done("srt_path", srt_path)


def parse_srt_time(time_str):
    parts = time_str.strip().replace(",", ":").split(":")
    h, m, s, ms = int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3])
    return h * 3600000 + m * 60000 + s * 1000 + ms

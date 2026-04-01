"""
步骤4：Fish Audio SDK 生成配音
"""
import os
from vf_utils import log, done, error, read_session, update_session, get_env


def run(session_path: str):
    try:
        from fish_audio_sdk import Session, TTSRequest
    except ImportError:
        error("请先安装 Fish Audio SDK: pip install fish-audio-sdk")

    session = read_session(session_path)
    out_dir = os.path.dirname(session_path)
    audio_path = os.path.join(out_dir, "audio.mp3")

    # 1. 检查是否已有音频
    if os.path.exists(audio_path):
        log(f"复用已有音频: {audio_path}")
        size_kb = os.path.getsize(audio_path) / 1024
        update_session(session_path, {
            "audio": {
                "audio_path": audio_path,
                "voice_id": session.get("audioConfig", {}).get("voiceId", get_env("VF_FISH_VOICE", "")),
                "status": "done"
            }
        })
        done("audio_path", audio_path)
        return

    rewrite = session.get("rewrite", {})
    text = rewrite.get("rewritten", "")
    if not text:
        text = session.get("extract", {}).get("raw_transcript", "")
    if not text:
        error("未找到文案内容，请先完成提取或改写步骤")

    fish_key = get_env("VF_FISH_KEY")
    fish_voice = get_env("VF_FISH_VOICE")
    if not fish_key:
        error("未配置 Fish Audio API Key，请在设置中填写")
    if not fish_voice:
        error("未配置 Fish Audio Voice ID，请在设置中填写")

    # 读取语速配置
    audio_cfg = session.get("audioConfig", {})
    speed = float(audio_cfg.get("speed", 1.0))
    voice_override = audio_cfg.get("voiceId", "")
    if voice_override:
        fish_voice = voice_override

    log(f"正在生成配音（语速 {speed}）...")
    fish_session = Session(fish_key)
    req = TTSRequest(text=text, reference_id=fish_voice, mp3_bitrate=128)

    with open(audio_path, "wb") as f:
        for chunk in fish_session.tts(req):
            f.write(chunk)

    size_kb = os.path.getsize(audio_path) / 1024
    log(f"配音已生成: {size_kb:.0f}KB")

    update_session(session_path, {
        "audio": {
            "audio_path": audio_path,
            "voice_id": fish_voice,
            "status": "done"
        }
    })
    done("audio_path", audio_path)

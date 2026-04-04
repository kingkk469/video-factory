"""
步骤2：Claude API 将原始文案改写为原创内容
"""
import requests
from vf_utils import log, done, error, read_session, update_session, get_env


def call_claude(prompt: str, max_tokens: int = 2000) -> str:
    base_url = get_env("VF_ANTHROPIC_BASE", "https://api.anthropic.com").rstrip("/")
    api_key = get_env("VF_ANTHROPIC_KEY")
    url = f"{base_url}/v1/messages"
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "user-agent": "claude-code/1.0.57 (external)",
        "anthropic-client-name": "claude-code",
        "anthropic-client-version": "1.0.57",
    }
    payload = {
        "model": "claude-opus-4-6",
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}]
    }
    proxy = get_env("HTTP_PROXY") or get_env("HTTPS_PROXY") or None
    proxies = {"http": proxy, "https": proxy} if proxy else None
    resp = requests.post(url, headers=headers, json=payload, proxies=proxies, timeout=120)
    resp.raise_for_status()
    data = resp.json()
    for block in data.get("content", []):
        if block.get("type") == "text":
            return block["text"].strip()
    error("Claude 未返回文本内容")


def run(session_path: str):
    session = read_session(session_path)
    extract = session.get("extract", {})
    raw = extract.get("raw_transcript", "")
    if not raw:
        error("未找到原始文案，请先执行提取步骤")

    log("正在调用 Claude 改写文案...")

    DEFAULT_PROMPT = """你是一位专业的短视频文案创作者。请将以下口播文案改写为全新原创内容。

# 人设定位
干练、直接，适合对着镜头朗读。

# 结构要求
直接输出改写后的完整文案正文，不需要添加标题、小标题、编号或任何额外说明。

# 断句要求（重要）
- 每个逗号或句号之间的文字不超过9个字
- 如果一句话超过9个字，必须在语义自然的地方插入逗号断开，不能生硬截断
- 断句要符合口语节奏，让人读起来自然流畅

# 严格限制
- 不得改变原文的核心观点和主要信息
- 不得凭空捏造案例、数据、引用或任何事实性内容
- 不得在原文未涉及人设的情况下强行植入用户人设信息
- 不得使用抖音平台违禁词和绝对化表述
- 不得输出任何非文案正文的内容（如分析过程、改写说明等）
- 用户人设信息中的真实背景不得篡改或夸大

# 执行指令
严格按照上述要求输出改写后的完整文案。

原始文案：
{raw}"""

    custom_prompt = get_env("VF_REWRITE_PROMPT", "")
    if custom_prompt:
        prompt = custom_prompt.replace("{raw}", raw) if "{raw}" in custom_prompt else custom_prompt + f"\n\n原始文案：\n{raw}"
    else:
        prompt = DEFAULT_PROMPT.format(raw=raw)

    rewritten = call_claude(prompt)
    log(f"改写完成，共 {len(rewritten)} 字")

    update_session(session_path, {
        "rewrite": {
            "rewritten": rewritten,
            "status": "done"
        }
    })
    done("rewritten", rewritten)

"""
步骤2：Claude API 将原始文案改写为原创内容
"""
import anthropic
from vf_utils import log, done, error, read_session, update_session, get_env


def get_client():
    return anthropic.Anthropic(
        base_url=get_env("VF_ANTHROPIC_BASE", "https://api.anthropic.com"),
        api_key=get_env("VF_ANTHROPIC_KEY"),
    )


def run(session_path: str):
    session = read_session(session_path)
    extract = session.get("extract", {})
    raw = extract.get("raw_transcript", "")
    if not raw:
        error("未找到原始文案，请先执行提取步骤")

    log("正在调用 Claude 改写文案...")
    client = get_client()

    prompt = f"""你是一位专业的短视频文案创作者。请将以下口播文案改写为全新原创内容。

# 人设定位
干练、直接，适合对着镜头朗读。

# 结构要求
直接输出改写后的完整文案正文，不需要添加标题、小标题、编号或任何额外说明。

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

    resp = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}]
    )
    # 找到 text 类型的 block（跳过 thinking block）
    rewritten = None
    for block in resp.content:
        if hasattr(block, 'text'):
            rewritten = block.text.strip()
            break
    if not rewritten:
        error("Claude 未返回文本内容")

    log(f"改写完成，共 {len(rewritten)} 字")

    update_session(session_path, {
        "rewrite": {
            "rewritten": rewritten,
            "status": "done"
        }
    })
    done("rewritten", rewritten)

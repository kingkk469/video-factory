"""
步骤3：Claude API 生成标题和话题标签
"""
import json
import anthropic
from vf_utils import log, done, error, read_session, update_session, get_env


def get_client():
    return anthropic.Anthropic(
        base_url=get_env("VF_ANTHROPIC_BASE", "https://api.anthropic.com"),
        api_key=get_env("VF_ANTHROPIC_KEY"),
    )


def run(session_path: str):
    session = read_session(session_path)
    rewrite = session.get("rewrite", {})
    text = rewrite.get("rewritten", "")
    if not text:
        # 回退到原始文案
        text = session.get("extract", {}).get("raw_transcript", "")
    if not text:
        error("未找到文案内容，请先完成提取或改写步骤")

    log("正在生成标题和话题标签...")
    client = get_client()

    prompt = f"""根据以下短视频口播文案，生成一个吸引人的标题和5-8个话题标签。

文案：
{text[:500]}

请严格按以下 JSON 格式输出，不要有任何其他内容：
{{
  "title": "吸引人的标题（20字以内）",
  "hashtags": ["话题1", "话题2", "话题3", "话题4", "话题5"]
}}"""

    resp = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=500,
        messages=[{"role": "user", "content": prompt}]
    )
    # 找到 text 类型的 block（跳过 thinking block）
    raw = None
    for block in resp.content:
        if hasattr(block, 'text'):
            raw = block.text.strip()
            break
    if not raw:
        error("Claude 未返回文本内容")

    # 提取 JSON
    import re
    m = re.search(r'\{.*\}', raw, re.DOTALL)
    if not m:
        error(f"Claude 返回格式异常: {raw}")
    result = json.loads(m.group(0))
    title = result.get("title", "")
    hashtags = result.get("hashtags", [])

    log(f"标题: {title}")
    log(f"话题: {' '.join('#'+t for t in hashtags)}")

    update_session(session_path, {
        "title": {
            "title": title,
            "hashtags": hashtags,
            "status": "done"
        }
    })
    done("title", {"title": title, "hashtags": hashtags})

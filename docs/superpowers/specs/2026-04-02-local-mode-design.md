# Local Mode Design — Video Factory

Date: 2026-04-02

## Goal

Add a local (free) mode alongside the existing cloud mode. Each of the three AI components can independently switch providers via a Tab UI on its card. The app ships as a small base package; local dependencies are detected and guided for installation.

## Scope

Three components get provider switching:

| Component | Cloud | Local |
|-----------|-------|-------|
| LLM (rewrite + title) | Claude API | Qwen via Ollama |
| TTS (audio) | Fish Audio | IndexTTS2 |
| Digital Human (video) | HeyGen | HeyGem |

## UI

Each affected card gets a two-tab strip at the top:

```
[☁ Fish Audio]  [💻 IndexTTS2]
```

**Audio card — Fish Audio tab** (existing fields, unchanged):
- Voice ID input
- Speed slider

**Audio card — IndexTTS2 tab** (new):
- Reference audio: file path input + pick button (per-session)
- Speed slider (shared)

**Video card — HeyGen tab** (existing fields, unchanged):
- Avatar dropdown + Avatar ID input

**Video card — HeyGem tab** (new):
- HeyGem Avatar ID input (per-session, user sets up avatar in HeyGem UI first)

**LLM section (left column, above rewrite + title buttons)**:
- Tab strip: `[☁ Claude]  [💻 Qwen]`
- Cloud tab: shows static label "使用 Claude API（在设置中配置）"
- Local tab: shows model name input (default: `qwen2.5:7b`)

## Settings Modal

Add a new "本地服务" section with:
- Ollama URL (default: `http://localhost:11434`)
- IndexTTS2 URL (default: `http://localhost:7860`)
- HeyGem URL (default: `http://localhost:8383`)

## Config (config.json)

New fields added to DEFAULT_CONFIG:

```json
{
  "llmProvider": "claude",
  "ttsProvider": "fish",
  "avatarProvider": "heygen",
  "ollamaUrl": "http://localhost:11434",
  "ollamaModel": "qwen2.5:7b",
  "indexTts2Url": "http://localhost:7860",
  "heygemUrl": "http://localhost:8383"
}
```

Provider and per-session values (reference audio, HeyGem avatar ID) are stored in `session.json` under `audioConfig` and `videoConfig`.

## Python Scripts

### rewrite.py + title.py

Read `VF_LLM_PROVIDER`:
- `"claude"` → existing Anthropic SDK path (unchanged)
- `"ollama"` → call `{VF_OLLAMA_URL}/v1/chat/completions` with `requests` (OpenAI-compatible), model = `VF_OLLAMA_MODEL`

### audio.py

Read `VF_TTS_PROVIDER`:
- `"fish"` → existing Fish Audio SDK path (unchanged)
- `"indextts2"` → POST to `{VF_INDEXTTS2_URL}/tts` with text + reference audio path, save response as `audio.mp3`

### video.py

Read `VF_AVATAR_PROVIDER`:
- `"heygen"` → existing HeyGen API path (unchanged)
- `"heygem"` → POST to `{VF_HEYGEM_URL}` with audio + avatar ID, poll for completion, download result

## main.js

- Extend `DEFAULT_CONFIG` with new fields
- Pass new env vars to Python: `VF_LLM_PROVIDER`, `VF_TTS_PROVIDER`, `VF_AVATAR_PROVIDER`, `VF_OLLAMA_URL`, `VF_OLLAMA_MODEL`, `VF_INDEXTTS2_URL`, `VF_HEYGEM_URL`
- Add `env:checkLocal` IPC: probe each local service URL, return health status
- Show local service status dots in statusbar when local provider is active

## Dependency Detection

On app start (or when switching to local tab), probe each local service:
- Ollama: `GET {ollamaUrl}/api/version`
- IndexTTS2: `GET {indexTts2Url}`
- HeyGem: `GET {heygemUrl}`

If unreachable: show red dot + install guide link in statusbar.

## Distribution

Base package ships without local models. Local mode is an opt-in for users who have set up the services. App detects and guides — no bundling of model weights.

## Out of Scope

- Auto-installing Ollama or IndexTTS2 (guide only, not auto-execute)
- HeyGem avatar creation UI (user sets up in HeyGem's own interface)
- Edge TTS or other fallback free-tier cloud providers

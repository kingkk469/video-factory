# Video Factory — 设计文档

**日期**：2026-04-01  
**项目路径**：`D:\video-factory\`  
**技术栈**：Electron + Python subprocess

---

## 一、产品目标

一款桌面工具，帮助短视频创作者完成从"抖音链接"到"多平台发布"的全自动流水线。七个功能模块随时可独立访问和调整，非强制线性。

---

## 二、整体架构

```
Electron 主进程 (main.js)
  ├── IPC 桥接 (ipcMain)          ← 接收 UI 指令，返回进度/结果
  ├── child_process.spawn         ← 按需启动 Python 子进程
  ├── Playwright 发布逻辑         ← 在主进程直接运行
  └── 会话状态管理                ← 读写 session.json

渲染进程 (renderer/)
  ├── 左侧导航（7 步始终可点）
  └── 右侧主内容区（当前步骤）

Python Scripts (scripts/)
  └── pipeline.py --step <name> --session <path>
        每步从 session.json 读取输入，结果写回 session.json
        通过 stdout 实时输出进度（JSON Lines 格式）
```

### 会话数据结构（session.json）

每次开始一个新视频任务，在 `D:\video-factory\sessions\<timestamp>\` 下创建：

```json
{
  "url": "https://v.douyin.com/...",
  "extract": { "raw_transcript": "...", "status": "done" },
  "rewrite": { "rewritten": "...", "status": "done" },
  "title": { "title": "...", "hashtags": ["#旅游", "#攻略"], "status": "done" },
  "audio": { "audio_path": "output.mp3", "voice_id": "xxx", "status": "done" },
  "video": { "video_url": "https://...", "avatar_id": "xxx", "status": "done" },
  "publish": { "platforms": ["douyin", "xiaohongshu"], "status": "pending" }
}
```

---

## 三、UI 设计

### 风格规范

- 背景：`#F5F5F7`（苹果浅灰），卡片白底 + 细阴影（`0 2px 12px rgba(0,0,0,0.08)`）
- 主色：`#0071E3`（苹果蓝），成功：`#34C759`，警告：`#FF9500`
- 字体：Inter（优先）/ 系统默认，正文 14px，标题 17px semi-bold
- 圆角：12px，无边框线，极简
- 步骤切换：200ms 淡入淡出

### 布局

```
┌─────────────────────────────────────────────────────┐
│  ● ● ●   Video Factory                   [设置图标] │
├─────────────────────────────────────────────────────┤
│           ████████████░░░░░░░░  进度条（蓝色细线）  │
├──────────────┬──────────────────────────────────────┤
│              │                                      │
│  1 输入链接  │                                      │
│  2 提取文案✅│       右侧主内容区                   │
│  3 AI改写 ✅ │       （当前选中步骤，大面积留白）    │
│  4 标题话题⏳│                                      │
│  5 生成配音  │                                      │
│  6 数字人视频│                                      │
│  7 发布      │                                      │
│              │                                      │
└──────────────┴──────────────────────────────────────┘
```

### 左侧导航（180px）

- 每项：图标 + 步骤名 + 状态指示点（灰=未开始，蓝=进行中，绿=已完成）
- 当前选中步骤：蓝色圆角背景块高亮
- **所有步骤始终可点击**，没有禁用态
- 修改已完成步骤后，其下游步骤的状态点变为橙色（"可能需要重新生成"），但不强制

### 各步骤右侧内容

| 步骤 | 主要内容 |
|------|---------|
| 1 输入链接 | 居中大输入框 + "开始提取"蓝色按钮，下方显示历史记录（最近5条） |
| 2 提取文案 | 可编辑文本框（白底卡片），右上角"重新提取"按钮，显示字数 |
| 3 AI 改写 | 上下两卡片：原始文案（灰色只读）/ 改写后（可编辑），"重新改写"按钮 |
| 4 标题+话题 | 标题输入框 + 话题标签（chip 样式，可删除/添加），"重新生成"按钮 |
| 5 生成配音 | voice_id 输入框 + 音频播放器（波形条+播放按钮），"重新生成"按钮 |
| 6 数字人视频 | avatar_id 输入框 + 视频预览卡，状态轮询进度条，"重新生成"按钮 |
| 7 发布 | 平台卡片（抖音/小红书/视频号），选中边框变蓝，"一键发布"按钮，发布日志 |

### 右下角实时日志抽屉

点击展开，显示 Python stdout 流式输出，灰色小字，便于调试。默认折叠。

---

## 四、Python 脚本结构

```
D:\video-factory\
└── scripts\
    ├── pipeline.py          ← 统一入口，--step 参数分发
    ├── extract.py           ← 下载+转录（复用 douyin_analyzer.py 逻辑）
    ├── rewrite.py           ← Claude API 改写
    ├── title.py             ← Claude API 生成标题+话题
    ├── audio.py             ← Fish Audio SDK（复用 fish_heygen.py 逻辑）
    ├── video.py             ← HeyGen API（复用 fish_heygen.py 逻辑）
    └── utils.py             ← session.json 读写、日志输出工具
```

### pipeline.py 调用方式

```bash
python pipeline.py --step extract --session D:\video-factory\sessions\1234\session.json
python pipeline.py --step rewrite --session D:\video-factory\sessions\1234\session.json
```

### stdout 协议（JSON Lines）

```json
{"type": "progress", "message": "正在下载视频..."}
{"type": "progress", "message": "Whisper 转录中..."}
{"type": "done", "key": "raw_transcript", "value": "...提取的文案..."}
{"type": "error", "message": "下载失败: 链接无效"}
```

---

## 五、IPC 通信

```
renderer → ipcMain: { channel: 'run-step', step: 'extract', sessionPath: '...' }

ipcMain:
  spawn('python', ['scripts/pipeline.py', '--step', step, '--session', sessionPath])
  每行 stdout → ipcMain.emit → renderer 更新 UI

renderer ← ipcMain: { type: 'progress'|'done'|'error', ... }
```

---

## 六、发布模块（Playwright）

发布逻辑在 Electron 主进程中运行（Node.js Playwright）：

- **抖音**：打开抖音创作者平台，上传视频文件，填写标题+话题，发布
- **小红书**：打开小红书创作者中心，上传，填写，发布
- **视频号**：打开微信视频号助手，上传，填写，发布

每个平台封装为独立函数，Cookie 通过 Playwright 持久化存储（`userDataDir`），首次使用需手动扫码登录一次。

---

## 七、目录结构

```
D:\video-factory\
├── package.json
├── main.js                  ← Electron 主进程
├── preload.js               ← IPC 桥接
├── renderer\
│   ├── index.html
│   ├── app.js               ← 主 UI 逻辑
│   └── styles.css           ← Apple 风格样式
├── scripts\                 ← Python 脚本
│   ├── pipeline.py
│   ├── extract.py
│   ├── rewrite.py
│   ├── title.py
│   ├── audio.py
│   ├── video.py
│   └── utils.py
├── publish\                 ← Playwright 发布脚本
│   ├── douyin.js
│   ├── xiaohongshu.js
│   └── weixin.js
├── sessions\                ← 运行时会话数据（gitignore）
└── docs\
    └── superpowers\specs\
        └── 2026-04-01-video-factory-design.md
```

---

## 八、不在范围内

- 声音克隆训练（用户已有 voice_id，直接填入使用）
- 数字人形象创建（用户已有 avatar_id）
- 视频剪辑/字幕（HeyGen 生成后直接用）
- 移动端/Web 版本

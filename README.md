# Video Insight

Video Insight 是一个用于学习 YouTube 英文长视频的 Chrome Side Panel 插件。

它帮助用户在观看英文长视频时获取实时滚动的中英字幕、针对字幕提问、记录笔记和积累生词。

## 我解决的问题

英文长视频的信息密度高，尤其是 AI、科技、商业和创业类内容,但对中文用户来说，会存在以下问题：

- 没有字幕的情况下看不懂，而目前市面上的字幕插件，要么句子切分不合理，要么翻译不准确；
- 看完后只留下模糊印象，难以复盘；
- 遇到关键句子时，想追问上下文但需要切换工具；
- 长视频学习成本高，用户很难持续把内容沉淀成自己的知识资产。

因此，我设计了Video Insight，它为**Youtube平台60分钟以内且语言为英文**的视频提供实时滚动字幕、基于字幕进行AI对话、笔记记录、生词查询的能力

## 核心功能

- 视频总览：基于字幕生成中文概要、章节划分和关键点。
- 歌词式字幕：字幕跟随 YouTube 播放进度高亮，也支持点击字幕跳转视频时间。
- 字幕选区操作：选中字幕后可以问 AI、记笔记、加入生词本和复制原文。
- 问AI：可以针对选中的字幕内容结合视频上下文进行问答和信息检索
- 记笔记：可以针对选中的字幕记录个人想法
- 加入生词本：可以针对选中的字幕自动判断生词类型（词组/单词）、中文翻译、字幕原文、生成更多例句
- 云端同步：使用 Supabase Auth 和数据库保存当前用户的视频学习记录。

## 核心用户流程

```text
打开 YouTube 视频页
↓
打开 Video Insight Side Panel
↓
插件识别视频信息
↓
点击“解析当前视频”
↓
获取英文字幕并生成中英学习内容
↓
查看总览和逐句字幕
↓
选中字幕后问 AI / 记笔记 / 加入生词本
↓
学习记录同步到 Supabase
```

## 当前状态

这是一个可本地运行的MVP版本：

- 核心学习闭环已完成，支持真实 YouTube 视频识别、英文字幕解析、AI 处理和学习记录同步
- 尚未上架 Chrome Web Store


## 当前边界与下一步

1. MVP 暂不支持：

- 非 YouTube 视频；
- 非英文视频；
- 60 分钟以上视频；
- 无字幕视频的语音转写；
- 深色模式；
- 全局资料库。

2. 当前不是 Chrome Web Store 可直接安装的公开产品，距离公开需要补齐：

- Chrome Web Store 图标、截图、录屏和商店文案；
- 隐私政策和权限说明；
- 生产环境后端鉴权、限流和成本控制；
- 真实用户 beta 测试；
- 更完整的失败场景和监控。

## 技术实现

主要技术栈：

- React
- TypeScript
- Tailwind CSS
- Chrome Extension Manifest V3
- Chrome Side Panel
- Supabase Auth / Database / Edge Function
- DeepSeek 模型调用
- Supadata 英文字幕获取

整体架构：

```text
YouTube 页面
↓
Chrome Content Script
↓
Chrome Side Panel
↓
Supabase Edge Function
↓
CaptionProvider / ModelProvider
↓
Supabase Database
```

安全边界：

- Chrome 插件前端只使用可公开配置；
- 模型 API Key、字幕服务 API Key、Supabase service role key 等敏感配置只放在后端环境变量或 Supabase secrets 中；
- 用户级数据按 userId 和 videoId 组织，后续全局资料库可以复用同一套数据结构。


## 本地开发

安装依赖：

```bash
npm install
```

复制环境变量模板：

```bash
cp .env.example .env
```

填写前端允许公开的 Supabase 配置：

```bash
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

启动开发服务：

```bash
npm run dev
```

构建 Chrome 插件：

```bash
npm run build
```

构建完成后，在 Chrome 打开 `chrome://extensions`，开启开发者模式，选择 `dist/` 目录作为未打包扩展加载。

## 后端配置

Supabase Edge Function 需要配置以下 secrets：

```bash
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=
SUPADATA_API_KEY=
```

其中 `DEEPSEEK_MODEL` 可选，未配置时使用代码中的默认模型。

## 项目结构

```text
src/
  services/   # 前端服务调用与云端数据读写
  types/      # 核心 TypeScript 类型
  utils/      # 字幕、时间、总览生成等工具函数
  mock/       # 本地 mock 数据
public/
  manifest.json
  background.js
  content.js
supabase/
  functions/  # Supabase Edge Functions
  migrations/ # 数据库迁移
docs/         # 产品、架构和开发文档
```

## 验证

当前可用的基础验证命令：

```bash
npm run build
```

项目还包含阶段性 smoke test：

```bash
node scripts/phase11-smoke-tests.mjs
```

## 文档

- [产品需求文档](docs/PRD.md)
- [技术架构](docs/TECH_ARCHITECTURE.md)
- [数据库设计](docs/DATABASE_SCHEMA.md)
- [开发计划](docs/DEVELOPMENT_PLAN.md)
- [AI 提示词](docs/AI_PROMPTS.md)

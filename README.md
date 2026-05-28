# Video Insight

Video Insight 是一个用于学习 YouTube 英文长视频的 Chrome Side Panel 插件。

它面向 AI、科技、商业、创业类英文长视频学习场景，帮助用户在观看视频时完成内容理解、中英字幕学习、针对字幕提问、记录笔记和积累生词。

## 当前状态

项目处于 MVP 阶段，核心形态是：

- Chrome Extension Manifest V3
- Chrome Side Panel
- React + TypeScript + Tailwind CSS
- Supabase Edge Function
- DeepSeek 模型调用
- Supadata 英文字幕获取

当前 MVP 只支持 YouTube 英文视频，且视频时长限制为 60 分钟以内。

## 核心功能

- 识别当前 YouTube 视频页的视频信息，包括 videoId、标题和时长
- 在解析前校验视频是否满足 MVP 条件
- 获取公开视频已有的英文字幕正文
- 对英文字幕进行自然断句和中文翻译
- 生成中文视频总览和章节摘要
- 在 Side Panel 中提供五个学习视图：总览、字幕、对话、笔记、生词
- 支持字幕跟随当前播放进度
- 支持选中字幕后提问、记笔记、加入生词本和复制原文

## 产品边界

Side Panel 只承载“当前视频学习”能力，不承载全局资料库。

后续全局资料库会用独立 Web App 承载，包括：

- 视频库
- 全局笔记
- 全局生词本
- 全局对话历史

MVP 暂不支持：

- 非 YouTube 视频
- 非英文视频
- 60 分钟以上视频
- 无字幕视频的语音转写
- 深色模式
- 全局资料库

## 技术架构

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

前端插件只使用可公开配置。模型 API Key、字幕服务 API Key、Supabase service role key 等敏感配置只允许放在后端环境变量或 Supabase secrets 中。

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

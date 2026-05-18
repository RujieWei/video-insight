# Video Insight 项目规则

## 1. 产品定位

Video Insight 是一个用于学习 YouTube 英文长视频的 Chrome 插件。

用户在 YouTube 视频页打开 Chrome Side Panel，通过 Video Insight 完成：
- 视频内容理解；
- 中英字幕学习；
- 针对字幕提问；
- 记录笔记；
- 积累生词和短语。

产品主线是“英文长视频内容学习”，英语学习是嵌入在内容学习过程中的能力。

## 2. 默认界面语言

产品界面默认使用中文。

所有用户可见文案，包括按钮、Tab、提示、错误信息、空状态、加载状态，默认都使用中文。

代码变量名、类型名、函数名可以使用英文。

示例：
- 总览
- 字幕
- 对话
- 笔记
- 生词
- 解析当前视频
- 问 AI
- 记笔记
- 加入生词本
- 复制原文
- 用 AI 重新整理
- 重新生成
- 保存
- 取消

## 3. 产品形态

MVP 是 Chrome Extension + Chrome Side Panel。

Side Panel 只承载“当前视频学习”能力，包含：
1. 总览
2. 字幕
3. 对话
4. 笔记
5. 生词

不要把全局资料库放进 Side Panel。

后续全局资料库会使用独立 Web App 承载，包括：
- 视频库
- 全局笔记
- 全局生词本
- 全局对话历史

## 4. 核心产品约束

- 只支持 YouTube。
- 只支持英文视频。
- 只支持 60 分钟以内的视频。
- 视频解析前必须获取 durationSeconds。
- 如果无法获取视频时长，则不能开始解析。
- UI 保持简洁、浅色、克制。
- 不做深色模式，除非后续任务明确要求。

## 5. 数据设计原则

数据以 videoId 和 userId 为核心组织。

视频级数据包括：
- videos
- video_analyses
- analysis_steps
- chapters
- timeline_items
- subtitle_segments

用户级数据包括：
- notes
- chat_threads
- chat_messages
- vocabulary_items
- vocabulary_sources

一个 videoId 对应一套视频解析数据。

一个 userId + videoId 对应该用户在该视频下的笔记、对话和生词来源。

后续全局资料库按 userId 汇总所有视频下的数据。

## 6. 技术栈

优先使用：
- React
- TypeScript
- Tailwind CSS
- Chrome Extension Manifest V3
- Chrome Side Panel
- Supabase，后续阶段
- ModelProvider 抽象层，后续阶段
- SearchProvider 抽象层，后续阶段

## 7. 代码组织

代码应拆分清晰，不要把所有逻辑写在一个文件里。

推荐目录：
- components/
- hooks/
- services/
- types/
- mock/
- utils/

所有核心数据结构都应定义 TypeScript types。

React 组件中不要直接写复杂业务逻辑，尽量放到 hooks、services 或 utils 中。

## 8. 安全规则

不要在前端写死任何真实 API Key。

模型 API Key、搜索 API Key、Supabase service role key 等敏感信息只能放在后端环境变量中。

Chrome 插件前端只能使用允许公开的配置，例如 Supabase anon key。
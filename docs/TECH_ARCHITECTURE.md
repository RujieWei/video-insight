# Video Insight 技术架构

## 1. 总体架构

Video Insight MVP 由三部分组成：

1. Chrome Extension
2. Backend API
3. Supabase

MVP 前期 Phase 0 / Phase 1 只实现 Chrome Extension，并使用 mock 数据。

后续阶段逐步接入 Backend API、Supabase、AI Model Provider、Search Provider 和真实 YouTube 字幕获取。

## 2. Chrome Extension

Chrome Extension 使用：
- Manifest V3
- React
- TypeScript
- Tailwind CSS
- Chrome Side Panel
- Content Script

### 2.1 Side Panel

Side Panel 负责当前视频学习界面。

包含 5 个 Tab：
1. 总览
2. 字幕
3. 对话
4. 笔记
5. 生词

Side Panel 不承载全局资料库。

### 2.2 Content Script

Content Script 运行在 YouTube 视频页。

负责：
- 识别当前页面是否为 YouTube 视频页；
- 读取 videoId；
- 读取当前 URL；
- 读取视频标题；
- 读取 durationSeconds；
- 监听当前播放时间；
- 控制 YouTube 视频跳转到指定时间；
- 与 Side Panel 通信。

## 3. Backend API

Backend API 负责所有不能放在插件前端的能力。

包括：
- 调用 AI 模型；
- 调用搜索 API；
- 获取真实 YouTube 字幕；
- 视频解析流程编排；
- 与 Supabase 读写数据；
- 隐藏敏感 API Key。

插件前端不能直接调用模型 API 或搜索 API。

## 4. Supabase

Supabase 负责：
- 用户登录；
- 云端数据库；
- 跨设备同步；
- 保存视频解析结果；
- 保存用户笔记、对话、生词。

MVP 后续阶段使用 Supabase Auth，优先支持邮箱 Magic Link / OTP。

## 5. ModelProvider

AI 模型调用通过 ModelProvider 抽象层实现。

不要在业务代码里绑定某一个模型供应商。

建议接口包括：
- segmentAndTranslateSubtitles
- generateOverview
- answerQuestion
- organizeNote
- extractVocabularyCandidates
- generateVocabularyDetails

可选实现：
- MockModelProvider
- OpenAIProvider
- QwenProvider
- ClaudeProvider

## 6. SearchProvider

联网搜索通过 SearchProvider 抽象层实现。

建议接口包括：
- search(query)
- extract(url)，后续可选

可选实现：
- MockSearchProvider
- TavilySearchProvider
- FutureBingSearchProvider

搜索 API 由后端调用，不由 Chrome 插件前端直接调用。

## 7. 字幕获取

Phase 0 / Phase 1 使用 mock 字幕。

后续真实字幕获取由 Backend API 实现。

MVP 只支持可获取英文字幕的视频。

如果无法获取英文字幕，返回错误：
“当前视频未检测到可用英文字幕，MVP 暂不支持无字幕视频或非英文视频解析。”

MVP 不支持无字幕视频语音转写。

## 8. 数据流

### 8.1 当前视频识别

```text
YouTube 页面
↓
Content Script
↓
Side Panel
```

### 8.2 视频解析

```text
Side Panel 点击“解析当前视频”
↓
Backend API
↓
获取字幕
↓
ModelProvider 处理字幕、摘要、章节、思维导图
↓
Supabase 保存结果
↓
Side Panel 读取并展示
```

### 8.3 选中字幕问 AI

```text
用户选中字幕
↓
Side Panel
↓
Backend API
↓
ModelProvider + SearchProvider
↓
Supabase 保存对话
↓
Side Panel 展示回答
```

### 8.4 记笔记

```text
用户选中字幕
↓
Side Panel 新增笔记编辑块
↓
可选：Backend API 调用 ModelProvider 整理内容
↓
用户保存
↓
Supabase 保存 note
```

### 8.5 加入生词本

```text
用户选中字幕
↓
Backend API 调用 ModelProvider 提取候选词
↓
用户勾选
↓
Backend API 生成释义和例句
↓
Supabase 保存 vocabulary_item 和 vocabulary_source
```

## 9. 安全边界

*   不要在 Chrome 插件前端写死真实模型 API Key。
    
*   不要在 Chrome 插件前端写死搜索 API Key。
    
*   不要在 Chrome 插件前端写死 Supabase service role key。
    
*   所有敏感 Key 必须放在后端环境变量。
    
*   Supabase RLS 必须限制用户只能访问自己的用户级数据。
    

## 10. 后续全局资料库

全局资料库不放在 Chrome Side Panel 中。

后续使用独立 Web App 承载：

*   视频库
    
*   全局笔记
    
*   全局生词本
    
*   全局对话历史
    

全局资料库复用同一套 Supabase 数据表。
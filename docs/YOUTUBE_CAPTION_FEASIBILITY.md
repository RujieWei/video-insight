# YouTube 字幕可行性 Spike

## 结论

Video Insight 值得继续做，但真实字幕链路不能简单假设为“后端直接抓 YouTube 字幕即可”。

本次 Spike 的判断：

1. `videoId`、标题、频道、时长、是否有字幕、字幕语言轨道这些元数据可行性高。
2. 官方 YouTube Data API 适合做元数据校验，但不适合作为“任意公开视频字幕正文”的主链路。
3. 页面数据里识别英文字幕轨道的成功率很高：本次 30 个 5-60 分钟 AI / 科技 / 创业 / 产品样本中，30/30 能识别到英文字幕轨。
4. 无登录、无 cookies、后端直接请求 `timedtext` 字幕正文不稳定：测试中能看到 `captionTracks.baseUrl`，但直接请求字幕正文返回空内容。这个现象意味着“自己在后端裸抓字幕”风险高。
5. 个人自用路线可以继续探索非官方方案或第三方 Transcript API；公开发布路线需要更保守，不能把非官方抓取包装成稳定官方能力。

产品边界不需要推翻。PRD 里“只支持可获取英文字幕的视频，拿不到字幕则当前视频无法解析”的设计是正确的。真正需要前置验证的是：可获取字幕的视频覆盖率、字幕正文获取方案、以及上线发布风险。

## 参考来源

- YouTube Videos API：`videos.list` 的 `snippet.defaultAudioLanguage`、`contentDetails.duration`、`contentDetails.caption` 可用于元数据判断。
  - https://developers.google.com/youtube/v3/docs/videos
- YouTube Captions API：`captions.list` 只返回字幕轨列表，不包含字幕正文；调用需要授权。
  - https://developers.google.cn/youtube/v3/docs/captions/list?hl=en
- YouTube Captions download：下载字幕需要授权，且一次调用配额成本为 200。
  - https://developers.google.com/youtube/v3/docs/captions/download?hl=zh-TW
- youtube-transcript-api：可获取人工字幕和自动字幕，但 README 明确提到云厂商 IP / 自托管 IP 可能遇到 `RequestBlocked` / `IpBlocked`，生产使用通常需要代理。
  - https://github.com/jdepoix/youtube-transcript-api
- Chrome Web Store Program Policies：扩展不得促进未经授权访问、下载或传播受版权保护内容，也需要明确披露用户数据使用。
  - https://developer.chrome.com/docs/webstore/program-policies/policies
- YouTube Terms of Service：限制未经授权复制、下载、自动化访问服务或内容。
  - https://yt-terms.static.usercontent.goog/pdf/terms/20231215/en_us_20231215.pdf

## 验证方式

本次没有安装新依赖，没有使用用户 YouTube 登录态或 cookies，没有使用 YouTube Data API Key。

实际验证分两层：

1. 页面播放器数据验证
   - 从公开视频页面读取 `ytInitialPlayerResponse`。
   - 记录 `videoDetails.lengthSeconds`、标题、频道、`captions.playerCaptionsTracklistRenderer.captionTracks`。
   - 判断是否存在英文字幕轨，区分 `standard` 与 `asr`。

2. 字幕正文直接拉取验证
   - 对带英文字幕轨的视频，尝试请求 `captionTracks.baseUrl`，并尝试 `json3`、`srv3`、`vtt` 等格式。
   - 结果：请求返回 HTTP 200，但正文为空。
   - 同时尝试 YouTube 内部 `get_transcript` endpoint，结果为 `400 Precondition check failed`。

这说明页面能识别字幕轨，不等于后端能稳定拿到字幕正文。

## 样本结果

样本选择方式：从 YouTube 搜索页抽样 AI / 科技 / 创业 / 产品相关公开视频，并过滤到 5-60 分钟。

统计结果：

| 指标 | 结果 |
| --- | ---: |
| 样本数量 | 30 |
| 5-60 分钟视频 | 30 |
| 页面数据中存在字幕轨 | 30 / 30 |
| 页面数据中存在英文字幕轨 | 30 / 30 |
| 人工英文字幕 `standard` | 17 / 30 |
| 自动英文字幕 `asr` | 13 / 30 |
| 无登录后端直接请求字幕正文 | 代表性测试失败 |

| # | videoId | 标题 | 频道 | 时长 | 英文字幕轨 |
| ---: | --- | --- | --- | ---: | --- |
| 1 | id4YRO7G0wE | The AI Revolution Is Underhyped | Eric Schmidt | TED | 25.6m | standard |
| 2 | eXdVDhOGqoE | AI Is Dangerous, but Not for the Reasons You Think | TED | 10.3m | standard |
| 3 | y8NtMZ7VGmU | With Spatial Intelligence, AI Will Understand the Real World | TED | 15.2m | standard |
| 4 | aZ5Kuowfc4g | The Jokes AI Won't Tell | TED | 8.5m | standard |
| 5 | 3lPnN8omdPA | How to Stop AI from Killing Your Critical Thinking | TED | 14.9m | standard |
| 6 | 7rzYDM6vMtI | How I Created OpenClaw, the Breakthrough AI Agent | TED | 17.6m | standard |
| 7 | cJfKqKEyw1o | AI is Coming for Your Job. Now What? | TED | 15.5m | standard |
| 8 | QOKLW5ITEiI | The future of AI, work, and human potential | TEDx Talks | 16.1m | asr |
| 9 | SHSmo72oVao | The Incredible Creativity of Deepfakes | TED | 13.1m | asr |
| 10 | tJV-vdbZ388 | Why AI Isn't Going to Become Conscious | TED | 15.0m | standard |
| 11 | FqlNhe8a_sM | Our next 20 years: AI, capitalism, and fractal minds | TEDx Talks | 16.1m | standard |
| 12 | uEztHu4NHrs | The Last 6 Decades of AI and What Comes Next | TED | 13.2m | standard |
| 13 | kND0iGErBk8 | Will AI Make Humans Useless? | TED | 11.5m | standard |
| 14 | KKNCiRWd_j0 | What Is an AI Anyway? | TED | 22.0m | standard |
| 15 | SoI9-PP5Tmk | Can Europe Win the Age of AI? | TED | 19.4m | standard |
| 16 | Kx6txsLiUT4 | Everything You Need to Know About AI Agents | TED | 18.6m | standard |
| 17 | 8nt3edWLgIg | Can we build AI without losing control over it? | TED | 14.5m | standard |
| 18 | B5tU2447OK8 | How to Apply And Succeed at Y Combinator | Y Combinator | 24.9m | asr |
| 19 | wH3TKpALlw4 | Starting A Company? The Key Terms You Should Know | Y Combinator | 17.9m | asr |
| 20 | nF_YWdz6S0Y | Startup Experts Reveal Their Top Productivity Advice | Y Combinator | 16.4m | asr |
| 21 | u36A-YTxiOw | The Best Way To Launch Your Startup | Y Combinator | 21.1m | asr |
| 22 | Pg72m3CjuK4 | Everything We Teach at YCombinator in 10 Minutes | Startup Istanbul | 10.3m | asr |
| 23 | l0h3nAW13ao | From Idea to $650M Exit: Lessons in Building AI Startups | Y Combinator | 39.4m | asr |
| 24 | LCEmiRjPEtQ | Andrej Karpathy: Software Is Changing Again | Y Combinator | 39.5m | asr |
| 25 | cFIlta1GkiE | Elon Musk: Digital Superintelligence, Multiplanetary Life | Y Combinator | 49.7m | asr |
| 26 | bxBzsSsqQAM | The 7 Most Powerful Moats For AI Startups | Y Combinator | 45.1m | asr |
| 27 | uqc_vt95GJg | Aaron Levie: Why Startups Win In The AI Era | Y Combinator | 40.5m | asr |
| 28 | JNyuX1zoOgU | Demis Hassabis: Agents, AGI & The Next Big Scientific Breakthrough | Y Combinator | 41.0m | asr |
| 29 | WsEQjeZoEng | Google I/O '24 in under 10 minutes | Google | 10.0m | standard |
| 30 | kTNFC9D0qeA | Google I/O 2024 Keynote: Gemini | Google | 10.0m | standard |

注意：这个表验证的是“页面数据中能否识别英文字幕轨”，不是最终字幕正文抓取成功率。后者需要正式 CaptionProvider Spike 继续验证。

## 方案评估

### 1. 官方合规路线

适合做：

- 获取视频时长。
- 获取标题、频道、基础语言字段。
- 判断 `contentDetails.caption` 是否为 true。
- 作为解析前校验的一部分。

不适合做：

- 获取任意公开视频的字幕正文。

原因：

- `captions.list` 不返回字幕正文。
- `captions.download` 需要 OAuth 授权，且更偏向视频所有者 / 内容合作方场景。
- 对你的产品来说，用户不是视频所有者，不能假设能通过官方 API 下载任意公开视频字幕。

结论：官方路线只能做元数据，不是字幕正文主链路。

### 2. 自建非官方后端抓取

适合做：

- 个人自用阶段的小规模验证。
- CaptionProvider 的实验性实现。

风险：

- 本次测试里，页面能拿到 `captionTracks.baseUrl`，但后端直接请求字幕正文为空。
- YouTube 可能依赖动态 token、访问上下文、风控或 Proof-of-Origin Token。
- 云服务器 IP 更容易被限制。
- 长期维护成本不可控。

结论：不建议作为公开发布 MVP 的主链路。可以作为个人自用实验，但要接受不稳定。

### 3. Chrome 页面内方案

潜在优势：

- 运行在用户正在看的 YouTube 页面旁边，更接近真实浏览器上下文。
- 可以稳定读取当前视频信息、播放时间、URL、标题和播放器状态。

核心不确定性：

- Chrome Extension 能看到页面 DOM 和部分播放器状态，但不能天然读取页面网络响应正文。
- 如果字幕正文只在 YouTube 内部接口或动态 token 下可用，插件仍然可能拿不到稳定正文。
- 如果依赖用户登录态或 cookies，需要明确用户授权和隐私披露。

结论：适合作为下一步重点验证方向，但还不能直接定为正式方案。

### 4. `youtube-transcript-api`

优点：

- 开源库明确支持人工字幕、自动字幕、时间戳、语言选择和翻译。
- 不需要官方 API Key。

风险：

- 本机没有安装该依赖，本次未安装、未运行。
- README 明确提到云厂商 IP、自托管 IP 可能遇到封锁，生产环境通常需要代理。
- 仍属于非官方路径，不适合作为公开发布时的“合规官方能力”。

结论：适合个人自用或后端实验；不建议在没有代理和容错策略前直接依赖。

### 5. 第三方 Transcript API

可选方向：

- Apify YouTube transcript actors。
- Supadata transcript API。
- TranscriptAPI / SerpAPI / Dumpling AI 等托管服务。

优点：

- 把抓取、代理、风控维护外包。
- 部分服务支持时间戳、自动字幕、无字幕时 AI 转写。

风险：

- 成本、稳定性、服务条款需要逐个确认。
- 对公开视频字幕的成功率仍要实测。
- 公开发布时仍要说明使用第三方服务处理用户正在看的视频 URL / 字幕数据。

结论：如果你想更快做出个人可用 MVP，第三方 Transcript API 是最现实的候选主链路。

## 推荐决策

### 适合公开发布的路线

推荐：

1. 继续 Phase 0 / Phase 1，用 mock 字幕跑通完整体验。
2. 官方 YouTube Data API 只用于元数据校验，不用于字幕正文。
3. 在真实字幕阶段新增 `CaptionProvider` 抽象：
   - `getVideoMetadata(videoId)`
   - `listCaptionTracks(videoId)`
   - `fetchTranscript(videoId, languageCode)`
4. 发布版不要承诺覆盖所有 YouTube 英文视频，只承诺支持“可获取英文字幕的视频”。
5. 如果使用第三方 Transcript API，需要在隐私政策和产品文案里说明会处理当前视频 URL 和字幕内容。

不推荐：

- 公开发布版本直接依赖自建非官方抓取。
- 在 Chrome Web Store 文案里暗示可以下载或提取任意 YouTube 字幕。

### 适合个人自用的路线

推荐：

1. 先接第三方 Transcript API 做真实链路验证。
2. 同时保留 mock provider，字幕失败时可以继续开发 UI。
3. 后续再比较第三方 API 与 `youtube-transcript-api` 的成功率、成本和维护压力。

个人自用可接受的风险：

- 某些视频拿不到字幕。
- 某些时间段接口失败。
- 可能需要更换 provider。

## 对现有文档的建议

### PRD

不需要改变产品定位。

建议后续补一句：

```text
“有英文字幕轨”不等于“字幕正文一定可获取”。实际解析以系统成功获取英文字幕正文为准。
```

### TECH_ARCHITECTURE

建议新增 `CaptionProvider`，不要把真实 YouTube 字幕获取直接写死到 Backend API 中。

建议候选实现：

```text
CaptionProvider
├─ MockCaptionProvider
├─ YouTubePageCaptionProvider
├─ ThirdPartyTranscriptProvider
└─ ExperimentalYouTubeTranscriptProvider
```

### DEVELOPMENT_PLAN

建议在 Phase 1 后、Supabase 前增加一个字幕技术 Spike：

```text
Phase 1.5
Caption feasibility spike:
- validate page-context caption access
- test one third-party Transcript API
- compare success rate and cost
- decide CaptionProvider v1
```

原因：字幕正文获取是主链路风险，应该早于 Supabase 和真实 AI。

## 是否继续 Phase 0

建议继续。

理由：

- 当前 PRD 的失败兜底是正确的。
- 样本中英文字幕轨识别率很高，说明你的目标内容类型并不是“完全没有字幕”的场景。
- 真正不确定的是字幕正文获取链路，而这个问题可以在 Phase 1 后通过独立 CaptionProvider Spike 再决策。

但要调整预期：

- Phase 0 / Phase 1 只做 mock 和入口状态，不碰真实字幕。
- 不要在早期安装一堆抓字幕依赖。
- 不要过早接 Supabase，先把 CaptionProvider 的可行性跑出来。

## 下一步建议

1. 保持 Phase 0：Chrome Extension + Side Panel + 页面识别 + 入口状态。
2. 保持 Phase 1：mock 学习流。
3. 在 Phase 1 后加入 Phase 1.5：字幕正文获取 Spike。
4. Phase 1.5 只需要验证 10 个你真实会看的视频，不需要再测 30 个泛样本。
5. 如果第三方 Transcript API 在这 10 个样本上成功率高，再进入 Supabase / AI 阶段。


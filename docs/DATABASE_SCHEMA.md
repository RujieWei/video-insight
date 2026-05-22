# 数据结构设计

## 数据组织原则

核心原则：

```text
videoId 组织视频级数据
userId 组织用户级数据
```

### 视频级公共数据

```text
videos
video_analyses
analysis_steps
chapters
timeline_items
subtitle_segments
```

这些数据与视频本身相关，可以被复用。

### 用户级私人数据

```text
notes
chat_threads
chat_messages
vocabulary_items
vocabulary_sources
```

这些数据必须绑定 userId。

---

## 更准确的数据关系

不是简单的：

一个视频 URL 对应一套用户数据。

而是：

一个 YouTube videoId 对应一套视频解析数据；  
一个 userId + videoId 对应该用户在该视频下创建的学习数据；  
后续全局资料库按 userId 汇总所有 videoId 下的数据。

---

## videos

```sql
create table videos (
  id uuid primary key default gen_random_uuid(),
  youtube_video_id text not null unique,
  url text not null,
  title text not null,
  channel_name text,
  duration_seconds integer not null,
  thumbnail_url text,
  language text,
  has_english_captions boolean default false,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);
```

## video\_analyses

```sql
create table video_analyses (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references videos(id) on delete cascade,
  status text not null default 'not_started',
  summary text,
  mindmap_mermaid text,
  language text default 'en',
  error_message text,
  is_partial boolean default false,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);
```

`status` 可选：

```text
not_started
validating
processing
partially_completed
completed
failed
```

## analysis\_steps

```sql
create table analysis_steps (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references video_analyses(id) on delete cascade,
  step_key text not null,
  step_name text not null,
  status text not null default 'pending',
  error_message text,
  order_index integer not null,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);
```

建议 step\_key：

```text
fetch_video_info
validate_video
fetch_captions
segment_subtitles
translate_subtitles
generate_summary
generate_chapters_timeline
save_results
```
---

## chapters

```sql
create table chapters (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references videos(id) on delete cascade,
  title text not null,
  summary text,
  start_time numeric not null,
  end_time numeric,
  key_points jsonb,
  order_index integer not null,
  created_at timestamp with time zone default now()
);
```
---

## timeline\_items

```sql
create table timeline_items (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references videos(id) on delete cascade,
  time_seconds numeric not null,
  title text not null,
  description text,
  order_index integer not null,
  created_at timestamp with time zone default now()
);
```
---

## subtitle\_segments

```sql
create table subtitle_segments (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references videos(id) on delete cascade,
  start_time numeric not null,
  end_time numeric not null,
  english_text text not null,
  chinese_text text,
  keywords jsonb,
  order_index integer not null,
  created_at timestamp with time zone default now()
);
```
---

## notes

```sql
create table notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  video_id uuid not null references videos(id) on delete cascade,
  subtitle_segment_id uuid references subtitle_segments(id) on delete set null,
  source_text text not null,
  source_translation text,
  ai_organized_text text,
  user_comment text,
  start_time numeric,
  end_time numeric,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);
```

### 当前视频笔记查询

```sql
select *
from notes
where user_id = :user_id
and video_id = :video_id
order by created_at desc;
```

### 后续全局笔记查询

```sql
select *
from notes
where user_id = :user_id
order by created_at desc;
```

## chat\_threads

```sql
create table chat_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  video_id uuid not null references videos(id) on delete cascade,
  title text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  unique(user_id, video_id)
);
```

### 说明

MVP 设计为：

每个用户在每个视频下有一个主对话线程。

如果后续要支持同一视频多个主题对话，可以调整这个约束。

---

## chat\_messages

```sql
create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references chat_threads(id) on delete cascade,
  role text not null,
  content text not null,
  selected_text text,
  subtitle_segment_id uuid references subtitle_segments(id) on delete set null,
  sources jsonb,
  created_at timestamp with time zone default now()
);
```

`sources` 示例：

```json
{
  "video": [
    {
      "subtitleSegmentId": "xxx",
      "startTime": 123.4
    }
  ],
  "web": [
    {
      "title": "Source title",
      "url": "https://example.com",
      "snippet": "..."
    }
  ]
}
```

### 后续全局对话

不需要新增全局对话表。  
全局对话通过：

```text
user_id → chat_threads → chat_messages
```

汇总。

---

## vocabulary\_items

```sql
create table vocabulary_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  text text not null,
  type text not null,
  meaning_zh text,
  examples jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  unique(user_id, text, type)
);
```

### 说明

`vocabulary_items` 保存“词条本体”。

它不直接绑定 video\_id。  
原因是同一个词 / 短语可能来自多个视频。

---

## vocabulary\_sources

```sql
create table vocabulary_sources (
  id uuid primary key default gen_random_uuid(),
  vocabulary_item_id uuid not null references vocabulary_items(id) on delete cascade,
  video_id uuid not null references videos(id) on delete cascade,
  subtitle_segment_id uuid references subtitle_segments(id) on delete set null,
  source_sentence text,
  source_translation text,
  start_time numeric,
  created_at timestamp with time zone default now()
);
```

### 当前视频生词查询

```text
查询当前 video_id 下的 vocabulary_sources
再关联 vocabulary_items
```

### 后续全局生词本查询

```text
查询当前 user_id 下的 vocabulary_items
再关联 vocabulary_sources
```

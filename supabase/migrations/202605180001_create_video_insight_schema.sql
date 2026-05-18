create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.videos (
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

create table public.video_analyses (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos(id) on delete cascade,
  status text not null default 'not_started',
  summary text,
  mindmap_mermaid text,
  language text default 'en',
  error_message text,
  is_partial boolean default false,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  unique(video_id),
  constraint video_analyses_status_check check (
    status in ('not_started', 'validating', 'processing', 'partially_completed', 'completed', 'failed')
  )
);

create table public.analysis_steps (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.video_analyses(id) on delete cascade,
  step_key text not null,
  step_name text not null,
  status text not null default 'pending',
  error_message text,
  order_index integer not null,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  unique(analysis_id, step_key),
  constraint analysis_steps_status_check check (status in ('pending', 'processing', 'completed', 'failed'))
);

create table public.chapters (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos(id) on delete cascade,
  title text not null,
  summary text,
  start_time numeric not null,
  end_time numeric,
  key_points jsonb,
  order_index integer not null,
  created_at timestamp with time zone default now()
);

create table public.timeline_items (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos(id) on delete cascade,
  time_seconds numeric not null,
  title text not null,
  description text,
  order_index integer not null,
  created_at timestamp with time zone default now()
);

create table public.subtitle_segments (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos(id) on delete cascade,
  start_time numeric not null,
  end_time numeric not null,
  english_text text not null,
  chinese_text text,
  keywords jsonb,
  order_index integer not null,
  created_at timestamp with time zone default now()
);

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  video_id uuid not null references public.videos(id) on delete cascade,
  subtitle_segment_id uuid references public.subtitle_segments(id) on delete set null,
  client_id text,
  source_text text not null,
  source_translation text,
  ai_organized_text text,
  user_comment text,
  start_time numeric,
  end_time numeric,
  is_saved boolean default true,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  unique(user_id, video_id, client_id)
);

create table public.chat_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  video_id uuid not null references public.videos(id) on delete cascade,
  title text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  unique(user_id, video_id)
);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  client_id text,
  role text not null,
  content text not null,
  selected_text text,
  subtitle_segment_id uuid references public.subtitle_segments(id) on delete set null,
  sources jsonb,
  created_at timestamp with time zone default now(),
  unique(thread_id, client_id),
  constraint chat_messages_role_check check (role in ('user', 'assistant', 'system'))
);

create table public.vocabulary_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  text text not null,
  type text not null,
  meaning_zh text,
  examples jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  unique(user_id, text, type),
  constraint vocabulary_items_type_check check (type in ('word', 'phrase'))
);

create table public.vocabulary_sources (
  id uuid primary key default gen_random_uuid(),
  vocabulary_item_id uuid not null references public.vocabulary_items(id) on delete cascade,
  video_id uuid not null references public.videos(id) on delete cascade,
  subtitle_segment_id uuid references public.subtitle_segments(id) on delete set null,
  client_id text,
  source_sentence text,
  source_translation text,
  start_time numeric,
  created_at timestamp with time zone default now(),
  unique(vocabulary_item_id, video_id, client_id)
);

create trigger set_videos_updated_at
before update on public.videos
for each row execute function public.set_updated_at();

create trigger set_video_analyses_updated_at
before update on public.video_analyses
for each row execute function public.set_updated_at();

create trigger set_analysis_steps_updated_at
before update on public.analysis_steps
for each row execute function public.set_updated_at();

create trigger set_notes_updated_at
before update on public.notes
for each row execute function public.set_updated_at();

create trigger set_chat_threads_updated_at
before update on public.chat_threads
for each row execute function public.set_updated_at();

create trigger set_vocabulary_items_updated_at
before update on public.vocabulary_items
for each row execute function public.set_updated_at();

create index videos_youtube_video_id_idx on public.videos(youtube_video_id);
create index video_analyses_video_id_idx on public.video_analyses(video_id);
create index analysis_steps_analysis_id_idx on public.analysis_steps(analysis_id);
create index chapters_video_id_order_idx on public.chapters(video_id, order_index);
create index timeline_items_video_id_order_idx on public.timeline_items(video_id, order_index);
create index subtitle_segments_video_id_order_idx on public.subtitle_segments(video_id, order_index);
create index notes_user_video_created_idx on public.notes(user_id, video_id, created_at desc);
create index chat_threads_user_video_idx on public.chat_threads(user_id, video_id);
create index chat_messages_thread_created_idx on public.chat_messages(thread_id, created_at);
create index vocabulary_items_user_text_idx on public.vocabulary_items(user_id, text);
create index vocabulary_sources_video_idx on public.vocabulary_sources(video_id);
create index vocabulary_sources_item_idx on public.vocabulary_sources(vocabulary_item_id);

alter table public.videos enable row level security;
alter table public.video_analyses enable row level security;
alter table public.analysis_steps enable row level security;
alter table public.chapters enable row level security;
alter table public.timeline_items enable row level security;
alter table public.subtitle_segments enable row level security;
alter table public.notes enable row level security;
alter table public.chat_threads enable row level security;
alter table public.chat_messages enable row level security;
alter table public.vocabulary_items enable row level security;
alter table public.vocabulary_sources enable row level security;

create policy "Authenticated users can read videos"
on public.videos for select to authenticated using (true);

create policy "Authenticated users can insert videos"
on public.videos for insert to authenticated with check (true);

create policy "Authenticated users can update videos"
on public.videos for update to authenticated using (true) with check (true);

create policy "Authenticated users can read video analyses"
on public.video_analyses for select to authenticated using (true);

create policy "Authenticated users can insert video analyses"
on public.video_analyses for insert to authenticated with check (true);

create policy "Authenticated users can update video analyses"
on public.video_analyses for update to authenticated using (true) with check (true);

create policy "Authenticated users can read analysis steps"
on public.analysis_steps for select to authenticated using (true);

create policy "Authenticated users can insert analysis steps"
on public.analysis_steps for insert to authenticated with check (true);

create policy "Authenticated users can update analysis steps"
on public.analysis_steps for update to authenticated using (true) with check (true);

create policy "Authenticated users can read chapters"
on public.chapters for select to authenticated using (true);

create policy "Authenticated users can insert chapters"
on public.chapters for insert to authenticated with check (true);

create policy "Authenticated users can read timeline items"
on public.timeline_items for select to authenticated using (true);

create policy "Authenticated users can insert timeline items"
on public.timeline_items for insert to authenticated with check (true);

create policy "Authenticated users can read subtitle segments"
on public.subtitle_segments for select to authenticated using (true);

create policy "Authenticated users can insert subtitle segments"
on public.subtitle_segments for insert to authenticated with check (true);

create policy "Users can manage own notes"
on public.notes for all to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy "Users can manage own chat threads"
on public.chat_threads for all to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy "Users can manage own chat messages"
on public.chat_messages for all to authenticated
using (
  exists (
    select 1
    from public.chat_threads
    where chat_threads.id = chat_messages.thread_id
    and chat_threads.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.chat_threads
    where chat_threads.id = chat_messages.thread_id
    and chat_threads.user_id = auth.uid()
  )
);

create policy "Users can manage own vocabulary items"
on public.vocabulary_items for all to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy "Users can manage own vocabulary sources"
on public.vocabulary_sources for all to authenticated
using (
  exists (
    select 1
    from public.vocabulary_items
    where vocabulary_items.id = vocabulary_sources.vocabulary_item_id
    and vocabulary_items.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.vocabulary_items
    where vocabulary_items.id = vocabulary_sources.vocabulary_item_id
    and vocabulary_items.user_id = auth.uid()
  )
);

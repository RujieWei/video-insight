grant usage on schema public to authenticated;

grant select, insert, update on public.videos to authenticated;
grant select, insert, update on public.video_analyses to authenticated;
grant select, insert, update on public.analysis_steps to authenticated;
grant select, insert, update on public.chapters to authenticated;
grant select, insert, update on public.timeline_items to authenticated;
grant select, insert, update on public.subtitle_segments to authenticated;

grant select, insert, update, delete on public.notes to authenticated;
grant select, insert, update, delete on public.chat_threads to authenticated;
grant select, insert, update, delete on public.chat_messages to authenticated;
grant select, insert, update, delete on public.vocabulary_items to authenticated;
grant select, insert, update, delete on public.vocabulary_sources to authenticated;

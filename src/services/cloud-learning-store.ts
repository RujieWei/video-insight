import { mockOverview } from "../mock/learning-data";
import { isSupabaseConfigured, supabase } from "./supabase";

export type CloudVideoInfo = {
  videoId: string | null;
  url: string;
  title: string;
  durationSeconds: number | null;
  channelName: string;
  thumbnailUrl: string;
};

export type CloudChatItem = {
  id: string;
  question: string;
  answer: string;
};

export type CloudNoteItem = {
  id: string;
  sourceText: string;
  sourceTranslation: string;
  aiOrganizedText?: string;
  userComment: string;
  startTime: number;
  endTime: number;
  isSaved: boolean;
};

export type CloudVocabularyItem = {
  id: string;
  text: string;
  type: "word" | "phrase";
  meaningZh: string;
  sourceSentence: string;
  sourceTranslation: string;
  example: {
    en: string;
    zh: string;
  };
};

export type CloudLearningState = {
  chatItems: CloudChatItem[];
  noteItems: CloudNoteItem[];
  vocabularyItems: CloudVocabularyItem[];
};

type VideoRow = {
  id: string;
};

type NoteRow = {
  id: string;
  client_id: string | null;
  source_text: string;
  source_translation: string | null;
  ai_organized_text: string | null;
  user_comment: string | null;
  start_time: number | null;
  end_time: number | null;
  is_saved: boolean | null;
};

type ChatMessageRow = {
  id: string;
  client_id: string | null;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

type VocabularySourceRow = {
  id: string;
  client_id: string | null;
  source_sentence: string | null;
  source_translation: string | null;
  vocabulary_item_id: string;
  vocabulary_items:
    | {
    id: string;
    text: string;
    type: "word" | "phrase";
    meaning_zh: string | null;
    examples: Array<{ en: string; zh: string }> | null;
  }
    | Array<{
        id: string;
        text: string;
        type: "word" | "phrase";
        meaning_zh: string | null;
        examples: Array<{ en: string; zh: string }> | null;
      }>
    | null;
};

function getClient() {
  if (!isSupabaseConfigured || !supabase) {
    return null;
  }

  return supabase;
}

async function findVideoRecordId(youtubeVideoId: string) {
  const client = getClient();

  if (!client) {
    return null;
  }

  const { data, error } = await client
    .from("videos")
    .select("id")
    .eq("youtube_video_id", youtubeVideoId)
    .maybeSingle<VideoRow>();

  if (error) {
    throw error;
  }

  return data?.id ?? null;
}

async function upsertVideoRecord(videoInfo: CloudVideoInfo) {
  const client = getClient();

  if (!client || !videoInfo.videoId || videoInfo.durationSeconds === null) {
    return null;
  }

  const { data, error } = await client
    .from("videos")
    .upsert(
      {
        youtube_video_id: videoInfo.videoId,
        url: videoInfo.url,
        title: videoInfo.title || "标题读取中",
        channel_name: videoInfo.channelName || null,
        duration_seconds: videoInfo.durationSeconds,
        thumbnail_url: videoInfo.thumbnailUrl || null,
        language: "en",
        has_english_captions: true
      },
      { onConflict: "youtube_video_id" }
    )
    .select("id")
    .single<VideoRow>();

  if (error) {
    throw error;
  }

  return data.id;
}

async function upsertVideoAnalysis(videoDbId: string) {
  const client = getClient();

  if (!client) {
    return;
  }

  const { error } = await client.from("video_analyses").upsert(
    {
      video_id: videoDbId,
      status: "completed",
      summary: mockOverview.summary,
      mindmap_mermaid: mockOverview.mindmapMermaid,
      language: "en",
      is_partial: false
    },
    { onConflict: "video_id" }
  );

  if (error) {
    throw error;
  }
}

async function upsertChatItems(userId: string, videoDbId: string, chatItems: CloudChatItem[]) {
  const client = getClient();

  if (!client || chatItems.length === 0) {
    return;
  }

  const { data: thread, error: threadError } = await client
    .from("chat_threads")
    .upsert(
      {
        user_id: userId,
        video_id: videoDbId,
        title: "当前视频对话"
      },
      { onConflict: "user_id,video_id" }
    )
    .select("id")
    .single<{ id: string }>();

  if (threadError) {
    throw threadError;
  }

  const messages = chatItems.flatMap((item) => [
    {
      thread_id: thread.id,
      client_id: `${item.id}:user`,
      role: "user",
      content: item.question
    },
    {
      thread_id: thread.id,
      client_id: `${item.id}:assistant`,
      role: "assistant",
      content: item.answer
    }
  ]);

  const { error } = await client
    .from("chat_messages")
    .upsert(messages, { onConflict: "thread_id,client_id" });

  if (error) {
    throw error;
  }
}

async function upsertNotes(userId: string, videoDbId: string, noteItems: CloudNoteItem[]) {
  const client = getClient();

  if (!client || noteItems.length === 0) {
    return;
  }

  const { error } = await client.from("notes").upsert(
    noteItems.map((item) => ({
      user_id: userId,
      video_id: videoDbId,
      client_id: item.id,
      source_text: item.sourceText,
      source_translation: item.sourceTranslation,
      ai_organized_text: item.aiOrganizedText ?? null,
      user_comment: item.userComment,
      start_time: item.startTime,
      end_time: item.endTime,
      is_saved: item.isSaved
    })),
    { onConflict: "user_id,video_id,client_id" }
  );

  if (error) {
    throw error;
  }
}

async function upsertVocabularyItems(
  userId: string,
  videoDbId: string,
  vocabularyItems: CloudVocabularyItem[]
) {
  const client = getClient();

  if (!client || vocabularyItems.length === 0) {
    return;
  }

  for (const item of vocabularyItems) {
    const { data: vocabularyItem, error: itemError } = await client
      .from("vocabulary_items")
      .upsert(
        {
          user_id: userId,
          text: item.text,
          type: item.type,
          meaning_zh: item.meaningZh,
          examples: [item.example]
        },
        { onConflict: "user_id,text,type" }
      )
      .select("id")
      .single<{ id: string }>();

    if (itemError) {
      throw itemError;
    }

    const { error: sourceError } = await client.from("vocabulary_sources").upsert(
      {
        vocabulary_item_id: vocabularyItem.id,
        video_id: videoDbId,
        client_id: item.id,
        source_sentence: item.sourceSentence,
        source_translation: item.sourceTranslation,
        start_time: null
      },
      { onConflict: "vocabulary_item_id,video_id,client_id" }
    );

    if (sourceError) {
      throw sourceError;
    }
  }
}

export async function saveCloudLearningState(
  userId: string,
  videoInfo: CloudVideoInfo,
  learningState: CloudLearningState
) {
  const videoDbId = await upsertVideoRecord(videoInfo);

  if (!videoDbId) {
    return;
  }

  await upsertVideoAnalysis(videoDbId);
  await upsertChatItems(userId, videoDbId, learningState.chatItems);
  await upsertNotes(userId, videoDbId, learningState.noteItems);
  await upsertVocabularyItems(userId, videoDbId, learningState.vocabularyItems);
}

export async function loadCloudLearningState(
  userId: string,
  videoInfo: CloudVideoInfo
): Promise<(CloudLearningState & { parsed: boolean }) | null> {
  const client = getClient();

  if (!client || !videoInfo.videoId) {
    return null;
  }

  const videoDbId = await findVideoRecordId(videoInfo.videoId);

  if (!videoDbId) {
    return null;
  }

  const { data: analysis } = await client
    .from("video_analyses")
    .select("id,status")
    .eq("video_id", videoDbId)
    .eq("status", "completed")
    .maybeSingle();

  const [notesResult, threadResult, vocabularyResult] = await Promise.all([
    client
      .from("notes")
      .select(
        "id,client_id,source_text,source_translation,ai_organized_text,user_comment,start_time,end_time,is_saved"
      )
      .eq("user_id", userId)
      .eq("video_id", videoDbId)
      .order("created_at", { ascending: false }),
    client
      .from("chat_threads")
      .select("id")
      .eq("user_id", userId)
      .eq("video_id", videoDbId)
      .maybeSingle<{ id: string }>(),
    client
      .from("vocabulary_sources")
      .select(
        "id,client_id,source_sentence,source_translation,vocabulary_item_id,vocabulary_items(id,text,type,meaning_zh,examples)"
      )
      .eq("video_id", videoDbId)
      .order("created_at", { ascending: false })
  ]);

  if (notesResult.error) {
    throw notesResult.error;
  }

  if (threadResult.error) {
    throw threadResult.error;
  }

  if (vocabularyResult.error) {
    throw vocabularyResult.error;
  }

  const chatItems = threadResult.data
    ? await loadChatItems(threadResult.data.id)
    : [];

  const noteItems = ((notesResult.data ?? []) as NoteRow[]).map((item) => ({
    id: item.client_id ?? item.id,
    sourceText: item.source_text,
    sourceTranslation: item.source_translation ?? "",
    aiOrganizedText: item.ai_organized_text ?? undefined,
    userComment: item.user_comment ?? "",
    startTime: Number(item.start_time ?? 0),
    endTime: Number(item.end_time ?? 0),
    isSaved: Boolean(item.is_saved)
  }));

  const vocabularyItems = ((vocabularyResult.data ?? []) as unknown as VocabularySourceRow[])
    .flatMap((source) => {
      const item = Array.isArray(source.vocabulary_items)
        ? source.vocabulary_items[0]
        : source.vocabulary_items;

      if (!item) {
        return [];
      }

      const firstExample = item.examples?.[0] ?? { en: "", zh: "" };

      return [{
        id: source.client_id ?? source.id,
        text: item.text,
        type: item.type,
        meaningZh: item.meaning_zh ?? "",
        sourceSentence: source.source_sentence ?? "",
        sourceTranslation: source.source_translation ?? "",
        example: firstExample
      }];
    });

  const hasUserData = chatItems.length > 0 || noteItems.length > 0 || vocabularyItems.length > 0;

  if (!analysis && !hasUserData) {
    return null;
  }

  return {
    parsed: Boolean(analysis),
    chatItems,
    noteItems,
    vocabularyItems
  };
}

async function loadChatItems(threadId: string) {
  const client = getClient();

  if (!client) {
    return [];
  }

  const { data, error } = await client
    .from("chat_messages")
    .select("id,client_id,role,content,created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  const messages = (data ?? []) as ChatMessageRow[];
  const chatItems: CloudChatItem[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];

    if (message.role !== "user") {
      continue;
    }

    const answer = messages.slice(index + 1).find((candidate) => candidate.role === "assistant");
    const clientId = message.client_id?.replace(":user", "") ?? message.id;

    chatItems.unshift({
      id: clientId,
      question: message.content,
      answer: answer?.content ?? ""
    });
  }

  return chatItems;
}

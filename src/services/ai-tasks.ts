import type { LearningOverview, SubtitleSegment } from "../types/learning";
import { isRetriableAiTaskError } from "../utils/ai-errors";
import {
  chunkOverviewSegments,
  createFallbackOverviewFromChunks,
  getOverviewCharacterCount,
  runOverviewChunkQueue,
  toOverviewSourceSegments,
  type OverviewChunkResult
} from "../utils/overview";
import { supabase } from "./supabase";

type AiTaskResponse<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; errorCode?: string };

type RawSubtitleSegment = {
  startTime: number;
  endTime: number;
  text: string;
};

export type SubtitleTranslationBatch = {
  batchIndex: number;
  segments: Array<{
    index: number;
    startTime: number;
    endTime: number;
    englishText: string;
  }>;
};

type TranscriptResult = {
  provider: "supadata";
  mode: "native";
  language: "en";
  segments: RawSubtitleSegment[];
};

const OVERVIEW_SINGLE_CALL_MAX_SEGMENTS = 120;
const OVERVIEW_SINGLE_CALL_MAX_CHARACTERS = 12000;
const OVERVIEW_CHUNK_MAX_SEGMENTS = 40;
const OVERVIEW_CHUNK_MAX_CHARACTERS = 4000;
const OVERVIEW_CHUNK_CONCURRENCY = 2;
const OVERVIEW_MAX_RETRIES = 2;
const OVERVIEW_RETRY_DELAY_MS = 800;

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function invokeOverviewTaskWithRetry<T>(task: string, payload: Record<string, unknown>) {
  let lastError: unknown;

  for (let attempt = 0; attempt <= OVERVIEW_MAX_RETRIES; attempt += 1) {
    try {
      return await invokeAiTask<T>(task, payload);
    } catch (error) {
      lastError = error;

      if (attempt >= OVERVIEW_MAX_RETRIES || !isRetriableAiTaskError(error)) {
        throw error;
      }

      await sleep(OVERVIEW_RETRY_DELAY_MS * (attempt + 1));
    }
  }

  throw lastError;
}

async function invokeAiTask<T>(task: string, payload: Record<string, unknown>) {
  if (!supabase) {
    throw new Error("Supabase is not configured");
  }

  const { data, error } = await supabase.functions.invoke<AiTaskResponse<T>>("ai-tasks", {
    body: { task, payload }
  });

  if (error) {
    const context = (error as { context?: unknown }).context;

    if (context instanceof Response) {
      let body: { message?: string; errorCode?: string } | null = null;

      try {
        body = (await context.clone().json()) as { message?: string; errorCode?: string };
      } catch {
        body = null;
      }

      if (body) {
        throw new Error(
          body.errorCode ? `${body.message || error.message}（${body.errorCode}）` : body.message || error.message
        );
      }
    }

    throw new Error(error.message);
  }

  if (!data?.ok) {
    throw new Error(
      data?.errorCode ? `${data.message || "生成失败"}（${data.errorCode}）` : data?.message || "生成失败"
    );
  }

  return data.data;
}

export async function segmentAndTranslateSubtitles(rawSegments: RawSubtitleSegment[]) {
  const result = await invokeAiTask<{ segments: SubtitleSegment[] }>("segmentAndTranslateSubtitles", {
    rawSegments
  });

  return result.segments;
}

export async function prepareSubtitleTranslationBatches(rawSegments: RawSubtitleSegment[]) {
  const result = await invokeAiTask<{ batches: SubtitleTranslationBatch[] }>(
    "prepareSubtitleTranslationBatches",
    {
      rawSegments
    }
  );

  return result.batches;
}

export async function translateSubtitleBatch(batch: SubtitleTranslationBatch) {
  const result = await invokeAiTask<{ segments: SubtitleSegment[] }>("translateSubtitleBatch", {
    batch
  });

  return result.segments;
}

export async function fetchTranscriptWithCaptionProvider(input: {
  videoUrl: string;
  videoId: string;
  language: "en";
}) {
  const result = await invokeAiTask<{ transcript: TranscriptResult }>("fetchTranscript", input);
  return result.transcript;
}

export async function generateOverview(segments: SubtitleSegment[], videoTitle?: string) {
  const overviewSegments = toOverviewSourceSegments(segments);
  const result = await invokeOverviewTaskWithRetry<{ overview: LearningOverview }>("generateOverview", {
    segments: overviewSegments,
    videoTitle
  });

  return result.overview;
}

export async function generateOverviewForLongVideo(segments: SubtitleSegment[], videoTitle?: string) {
  const overviewSegments = toOverviewSourceSegments(segments);

  if (
    overviewSegments.length <= OVERVIEW_SINGLE_CALL_MAX_SEGMENTS &&
    getOverviewCharacterCount(overviewSegments) <= OVERVIEW_SINGLE_CALL_MAX_CHARACTERS
  ) {
    try {
      const result = await invokeOverviewTaskWithRetry<{ overview: LearningOverview }>("generateOverview", {
        segments: overviewSegments,
        videoTitle
      });

      return result.overview;
    } catch (error) {
      if (!isRetriableAiTaskError(error)) {
        throw error;
      }
    }
  }

  const chunks = await runOverviewChunkQueue({
    chunks: chunkOverviewSegments(overviewSegments, {
      maxSegments: OVERVIEW_CHUNK_MAX_SEGMENTS,
      maxCharacters: OVERVIEW_CHUNK_MAX_CHARACTERS
    }),
    concurrency: OVERVIEW_CHUNK_CONCURRENCY,
    generateChunk: async (chunkInput) => {
      const result = await invokeOverviewTaskWithRetry<{ chunk: OverviewChunkResult }>(
        "generateOverviewChunk",
        chunkInput
      );
      return result.chunk;
    }
  });

  try {
    const result = await invokeOverviewTaskWithRetry<{ overview: LearningOverview }>(
      "generateOverviewFromChunks",
      {
        chunks,
        videoTitle
      }
    );

    return result.overview;
  } catch (error) {
    if (!isRetriableAiTaskError(error)) {
      throw error;
    }

    return createFallbackOverviewFromChunks(chunks, videoTitle);
  }
}

export async function organizeNoteWithAi(input: {
  sourceText: string;
  sourceTranslation: string;
  previousOrganizedText?: string;
}) {
  const result = await invokeAiTask<{ organizedText: string }>("organizeNote", input);
  return result.organizedText;
}

export async function answerQuestionWithAi(input: {
  question: string;
  videoTitle: string;
  overviewSummary: string;
  subtitles: SubtitleSegment[];
  recentChat: Array<{
    question: string;
    answer: string;
  }>;
}) {
  const result = await invokeAiTask<{ answer: string }>("answerQuestion", input);
  return result.answer;
}

export async function generateVocabularyItemWithAi(input: {
  selectedText: string;
  sourceSentence: string;
  sourceTranslation: string;
  videoContext: string;
}) {
  const result = await invokeAiTask<{
    item: {
      normalizedText: string;
      meaningZh: string;
    };
  }>("generateVocabularyItem", input);

  return result.item;
}

export async function generateVocabularyExamplesWithAi(input: {
  text: string;
  type: "word" | "phrase";
  meaningZh: string;
  sourceSentence: string;
  sourceTranslation: string;
  videoContext: string;
  existingExamples: Array<{ en: string; zh: string }>;
}) {
  const result = await invokeAiTask<{
    examples: Array<{ en: string; zh: string }>;
  }>("generateVocabularyExamples", input);

  return result.examples;
}

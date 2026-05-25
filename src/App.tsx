import * as React from "react";
import { mockOverview, mockSubtitleSegments } from "./mock/learning-data";
import {
  answerQuestionWithAi,
  fetchTranscriptWithCaptionProvider,
  generateVocabularyExamplesWithAi,
  generateVocabularyItemWithAi,
  generateOverviewForLongVideo,
  organizeNoteWithAi,
  prepareSubtitleTranslationBatches,
  translateSubtitleBatch,
  type SubtitleTranslationBatch
} from "./services/ai-tasks";
import { loadCloudLearningState, saveCloudLearningState } from "./services/cloud-learning-store";
import {
  isSupabaseConfigured,
  supabase,
  type SupabaseUser
} from "./services/supabase";
import type { LearningOverview, SubtitleSegment } from "./types/learning";
import { isRetriableAiTaskError } from "./utils/ai-errors";
import {
  getPendingBatchIndexes,
  mergeCompletedBatchResults,
  runSubtitleBatchQueue,
  upsertCompletedBatchResult,
  type CompletedBatchResult,
  type ParseCheckpoint
} from "./utils/parse-checkpoint";
import { findActiveSubtitleIndex } from "./utils/subtitles";
import { formatDuration } from "./utils/time";

type VideoInfo = {
  isYouTubeVideoPage: boolean;
  videoId: string | null;
  url: string;
  title: string;
  durationSeconds: number | null;
  channelName: string;
  thumbnailUrl: string;
  collectedAt: number;
};

type PanelState =
  | { status: "identifying" }
  | { status: "unparseable"; reason: string; detail: string; url?: string; videoInfo?: VideoInfo }
  | { status: "readyToParse"; videoInfo: VideoInfo }
  | { status: "parsing"; videoInfo: VideoInfo }
  | { status: "learning"; videoInfo: VideoInfo };

type ParseStepStatus = "pending" | "processing" | "completed" | "failed";

type ParseStep = {
  key: string;
  label: string;
};

type LearningTabKey = "overview" | "subtitles" | "chat" | "notes" | "vocabulary";

type LearningTab = {
  key: LearningTabKey;
  label: string;
};

type CloudSyncStatus = "idle" | "syncing" | "synced" | "error";
type GenerationSource = "mock" | "ai" | "partial" | "failed";
type ChatSource = "mock" | "ai" | "failed" | "loading";

type PlaybackTimePayload = {
  videoId: string;
  currentTime: number;
  collectedAt: number;
};

type SelectedSubtitle = {
  text: string;
  segment: SubtitleSegment;
  x: number;
  y: number;
};

type MockChatItem = {
  id: string;
  question: string;
  answer: string;
  source?: ChatSource;
};

type MockNoteItem = {
  id: string;
  sourceText: string;
  sourceTranslation: string;
  aiOrganizedText?: string;
  userComment: string;
  startTime: number;
  endTime: number;
  isSaved: boolean;
  aiOrganizeFailed?: boolean;
  aiOrganizing?: boolean;
};

type MockVocabularyItem = {
  id: string;
  text: string;
  type: "word" | "phrase";
  meaningZh: string;
  sourceSentence: string;
  sourceTranslation: string;
  example?: {
    en: string;
    zh: string;
  };
  generatedExamples?: Array<{
    en: string;
    zh: string;
  }>;
  examplesGenerating?: boolean;
  examplesGenerationFailed?: boolean;
};

type StoredLearningState = {
  parsed: true;
  overview?: LearningOverview | null;
  subtitleSegments?: SubtitleSegment[];
  overviewSource?: GenerationSource;
  subtitleSource?: GenerationSource;
  overviewGenerationFailed?: boolean;
  chatItems: MockChatItem[];
  noteItems: MockNoteItem[];
  vocabularyItems: MockVocabularyItem[];
  updatedAt: number;
};

type VideoParseCheckpoint = ParseCheckpoint<VideoInfo, SubtitleTranslationBatch>;

const VIDEO_INFO_REQUEST = "VIDEO_INSIGHT_GET_VIDEO_INFO";
const VIDEO_INFO_UPDATED = "VIDEO_INSIGHT_VIDEO_INFO_UPDATED";
const PLAYBACK_TIME_UPDATED = "VIDEO_INSIGHT_PLAYBACK_TIME_UPDATED";
const SEEK_TO_TIME = "VIDEO_INSIGHT_SEEK_TO_TIME";
const ENGLISH_CAPTIONS_REQUEST = "VIDEO_INSIGHT_GET_ENGLISH_CAPTIONS";
const STORAGE_KEY_PREFIX = "video-insight:learning:";
const PARSE_CHECKPOINT_KEY_PREFIX = "video-insight:parse-checkpoint:";
const SUBTITLE_TRANSLATION_CONCURRENCY = 3;

const MOCK_PARSE_STEPS: ParseStep[] = [
  { key: "fetch_captions", label: "获取英文字幕" },
  { key: "segment_subtitles", label: "重切分字幕" },
  { key: "translate_subtitles", label: "翻译中文字幕" },
  { key: "generate_summary", label: "生成整体摘要" },
  { key: "generate_chapters_timeline", label: "生成章节" },
  { key: "save_results", label: "保存解析结果" }
];

const LEARNING_TABS: LearningTab[] = [
  { key: "overview", label: "总览" },
  { key: "subtitles", label: "字幕" },
  { key: "chat", label: "对话" },
  { key: "notes", label: "笔记" },
  { key: "vocabulary", label: "生词" }
];

function createInitialParseStepStatuses() {
  return MOCK_PARSE_STEPS.reduce<Record<string, ParseStepStatus>>((statuses, step) => {
    statuses[step.key] = "pending";
    return statuses;
  }, {});
}

type RawCaptionSegment = {
  startTime: number;
  endTime: number;
  text: string;
};

type EnglishCaptionsResult =
  | {
      ok: true;
      payload: {
        track: {
          languageCode: string;
          name: string;
          kind: string;
        };
        segments: RawCaptionSegment[];
      };
    }
  | {
      ok: false;
      errorCode: string;
      message: string;
    };

function createCompletedParseStepStatuses() {
  return MOCK_PARSE_STEPS.reduce<Record<string, ParseStepStatus>>((statuses, step) => {
    statuses[step.key] = "completed";
    return statuses;
  }, {});
}

function getLearningStorageKey(videoId: string) {
  return `${STORAGE_KEY_PREFIX}${videoId}`;
}

function getParseCheckpointStorageKey(videoId: string) {
  return `${PARSE_CHECKPOINT_KEY_PREFIX}${videoId}`;
}

function normalizeStoredLearningState(value: unknown): StoredLearningState | null {
  const maybeState = value as Partial<StoredLearningState> | undefined;

  if (!maybeState?.parsed) {
    return null;
  }

  return {
    parsed: true,
    overview: maybeState.overview ?? undefined,
    subtitleSegments: Array.isArray(maybeState.subtitleSegments) ? maybeState.subtitleSegments : undefined,
    overviewSource: maybeState.overviewSource,
    subtitleSource: maybeState.subtitleSource,
    overviewGenerationFailed: Boolean(maybeState.overviewGenerationFailed),
    chatItems: Array.isArray(maybeState.chatItems) ? maybeState.chatItems : [],
    noteItems: Array.isArray(maybeState.noteItems) ? maybeState.noteItems : [],
    vocabularyItems: Array.isArray(maybeState.vocabularyItems) ? maybeState.vocabularyItems : [],
    updatedAt: typeof maybeState.updatedAt === "number" ? maybeState.updatedAt : 0
  };
}

function loadStoredLearningState(videoId: string) {
  return new Promise<StoredLearningState | null>((resolve) => {
    const key = getLearningStorageKey(videoId);

    chrome.storage.local.get(key, (result) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }

      resolve(normalizeStoredLearningState(result[key]));
    });
  });
}

function saveStoredLearningState(videoId: string, state: StoredLearningState) {
  return new Promise<void>((resolve) => {
    chrome.storage.local.set({ [getLearningStorageKey(videoId)]: state }, () => {
      resolve();
    });
  });
}

function normalizeParseCheckpoint(value: unknown): VideoParseCheckpoint | null {
  const checkpoint = value as Partial<VideoParseCheckpoint> | undefined;

  if (!checkpoint?.videoInfo?.videoId || !Array.isArray(checkpoint.batches)) {
    return null;
  }

  return {
    videoInfo: checkpoint.videoInfo,
    batches: checkpoint.batches,
    completedBatchResults: Array.isArray(checkpoint.completedBatchResults)
      ? checkpoint.completedBatchResults
      : [],
    failedBatchIndexes: Array.isArray(checkpoint.failedBatchIndexes)
      ? checkpoint.failedBatchIndexes.filter((index) => typeof index === "number")
      : [],
    status: checkpoint.status ?? "translating",
    updatedAt: typeof checkpoint.updatedAt === "number" ? checkpoint.updatedAt : 0
  };
}

function loadParseCheckpoint(videoId: string) {
  return new Promise<VideoParseCheckpoint | null>((resolve) => {
    const key = getParseCheckpointStorageKey(videoId);

    chrome.storage.local.get(key, (result) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }

      resolve(normalizeParseCheckpoint(result[key]));
    });
  });
}

function saveParseCheckpoint(videoId: string, checkpoint: VideoParseCheckpoint) {
  return new Promise<void>((resolve) => {
    chrome.storage.local.set({ [getParseCheckpointStorageKey(videoId)]: checkpoint }, () => {
      resolve();
    });
  });
}

function removeParseCheckpoint(videoId: string) {
  return new Promise<void>((resolve) => {
    chrome.storage.local.remove(getParseCheckpointStorageKey(videoId), () => {
      resolve();
    });
  });
}

function isYouTubeUrl(url?: string) {
  if (!url) {
    return false;
  }

  try {
    return new URL(url).hostname.includes("youtube.com");
  } catch {
    return false;
  }
}

function isYouTubeWatchUrl(url?: string) {
  if (!url) {
    return false;
  }

  try {
    const parsedUrl = new URL(url);
    return parsedUrl.hostname.includes("youtube.com") && parsedUrl.pathname === "/watch";
  } catch {
    return false;
  }
}

async function getActiveTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return activeTab;
}

function requestVideoInfo(tabId: number) {
  return chrome.tabs.sendMessage(tabId, { type: VIDEO_INFO_REQUEST }) as Promise<{
    type: typeof VIDEO_INFO_UPDATED;
    payload: VideoInfo;
  }>;
}

function seekActiveTabToTime(tabId: number, timeSeconds: number) {
  return chrome.tabs.sendMessage(tabId, {
    type: SEEK_TO_TIME,
    payload: { timeSeconds }
  }) as Promise<{ ok: boolean }>;
}

async function requestEnglishCaptionsFromPageWorld(tabId: number): Promise<EnglishCaptionsResult> {
  const executionResults = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async () => {
      function extractJsonObjectAfterMarker(source: string, marker: string) {
        const markerIndex = source.indexOf(marker);

        if (markerIndex < 0) {
          return null;
        }

        const startIndex = source.indexOf("{", markerIndex);

        if (startIndex < 0) {
          return null;
        }

        let depth = 0;
        let inString = false;
        let isEscaped = false;

        for (let index = startIndex; index < source.length; index += 1) {
          const char = source[index];

          if (inString) {
            if (isEscaped) {
              isEscaped = false;
            } else if (char === "\\") {
              isEscaped = true;
            } else if (char === "\"") {
              inString = false;
            }

            continue;
          }

          if (char === "\"") {
            inString = true;
            continue;
          }

          if (char === "{") {
            depth += 1;
          } else if (char === "}") {
            depth -= 1;

            if (depth === 0) {
              return source.slice(startIndex, index + 1);
            }
          }
        }

        return null;
      }

      function parseInitialPlayerResponseFromText(text: string) {
        if (!text.includes("ytInitialPlayerResponse")) {
          return null;
        }

        const jsonText = extractJsonObjectAfterMarker(text, "ytInitialPlayerResponse");

        if (!jsonText) {
          return null;
        }

        try {
          return JSON.parse(jsonText);
        } catch {
          return null;
        }
      }

      function findObjectWithKey(value: unknown, targetKey: string): Record<string, unknown> | null {
        if (!value || typeof value !== "object") {
          return null;
        }

        if (Object.prototype.hasOwnProperty.call(value, targetKey)) {
          return value as Record<string, unknown>;
        }

        if (Array.isArray(value)) {
          for (const item of value) {
            const result = findObjectWithKey(item, targetKey);

            if (result) {
              return result;
            }
          }

          return null;
        }

        for (const child of Object.values(value)) {
          const result = findObjectWithKey(child, targetKey);

          if (result) {
            return result;
          }
        }

        return null;
      }

      function parseInitialDataFromText(text: string) {
        if (!text.includes("ytInitialData")) {
          return null;
        }

        const jsonText = extractJsonObjectAfterMarker(text, "ytInitialData");

        if (!jsonText) {
          return null;
        }

        try {
          return JSON.parse(jsonText);
        } catch {
          return null;
        }
      }

      function readInitialData() {
        const pageWindow = window as typeof window & {
          ytInitialData?: unknown;
        };

        if (pageWindow.ytInitialData) {
          return pageWindow.ytInitialData;
        }

        for (const script of Array.from(document.scripts)) {
          const initialData = parseInitialDataFromText(script.textContent || "");

          if (initialData) {
            return initialData;
          }
        }

        return null;
      }

      function readYtcfgValue(key: string) {
        const pageWindow = window as typeof window & {
          ytcfg?: {
            get?: (key: string) => unknown;
          };
        };

        if (typeof pageWindow.ytcfg?.get === "function") {
          const value = pageWindow.ytcfg.get(key);

          if (value) {
            return value;
          }
        }

        for (const script of Array.from(document.scripts)) {
          const text = script.textContent || "";

          if (!text.includes("ytcfg.set") || !text.includes(key)) {
            continue;
          }

          const jsonText = extractJsonObjectAfterMarker(text, "ytcfg.set");

          if (!jsonText) {
            continue;
          }

          try {
            const config = JSON.parse(jsonText) as Record<string, unknown>;
            const value = config[key];

            if (value) {
              return value;
            }
          } catch {
            continue;
          }
        }

        return null;
      }

      function readPlayerResponseFromPlayerElement() {
        const player = document.querySelector("#movie_player") as
          | (Element & { getPlayerResponse?: () => unknown })
          | null;

        if (typeof player?.getPlayerResponse !== "function") {
          return null;
        }

        try {
          return player.getPlayerResponse();
        } catch {
          return null;
        }
      }

      async function readPlayerResponse() {
        const pageWindow = window as typeof window & {
          ytInitialPlayerResponse?: unknown;
        };
        const currentPlayerResponse =
          readPlayerResponseFromPlayerElement() || pageWindow.ytInitialPlayerResponse;

        if (currentPlayerResponse) {
          return currentPlayerResponse;
        }

        for (const script of Array.from(document.scripts)) {
          const scriptPlayerResponse = parseInitialPlayerResponseFromText(script.textContent || "");

          if (scriptPlayerResponse) {
            return scriptPlayerResponse;
          }
        }

        const watchUrl = new URL(window.location.href);
        watchUrl.searchParams.set("hl", "en");

        const response = await fetch(watchUrl.toString(), {
          credentials: "include"
        });

        if (!response.ok) {
          return null;
        }

        return parseInitialPlayerResponseFromText(await response.text());
      }

      type PageCaptionTrack = {
        baseUrl?: string;
        languageCode?: string;
        kind?: string;
        name?: {
          simpleText?: string;
          runs?: Array<{ text?: string }>;
        };
      };

      function chooseEnglishCaptionTrack(captionTracks: PageCaptionTrack[]) {
        const englishTracks = captionTracks.filter((track) => {
          const languageCode = String(track.languageCode || "").toLowerCase();
          return languageCode === "en" || languageCode.startsWith("en-");
        });

        if (englishTracks.length === 0) {
          return null;
        }

        return englishTracks.find((track) => track.kind !== "asr") || englishTracks[0];
      }

      function normalizeCaptionText(text: string) {
        return text
          .replace(/\s+/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, "\"")
          .replace(/&#39;/g, "'")
          .trim();
      }

      function parseTranscriptSegments(value: unknown) {
        const segments: Array<{ startTime: number; endTime: number; text: string }> = [];

        function visit(node: unknown) {
          if (!node || typeof node !== "object") {
            return;
          }

          if (Array.isArray(node)) {
            node.forEach(visit);
            return;
          }

          const record = node as Record<string, unknown>;
          const renderer = record.transcriptSegmentRenderer as
            | {
                startMs?: string;
                endMs?: string;
                snippet?: {
                  runs?: Array<{ text?: string }>;
                };
              }
            | undefined;

          if (renderer?.snippet?.runs) {
            const startMs = Number(renderer.startMs);
            const endMs = Number(renderer.endMs);
            const text = normalizeCaptionText(
              renderer.snippet.runs.map((run) => run.text || "").join("")
            );

            if (text && Number.isFinite(startMs)) {
              const startTime = startMs / 1000;
              const endTime = Number.isFinite(endMs) && endMs > startMs ? endMs / 1000 : startTime + 3;
              segments.push({ startTime, endTime, text });
            }

            return;
          }

          Object.values(record).forEach(visit);
        }

        visit(value);

        return segments;
      }

      async function fetchTranscriptSegments() {
        const initialData = readInitialData();
        const endpointContainer = findObjectWithKey(initialData, "getTranscriptEndpoint");
        const params =
          (
            endpointContainer?.getTranscriptEndpoint as
              | {
                  params?: string;
                }
              | undefined
          )?.params || "";
        const apiKey = String(readYtcfgValue("INNERTUBE_API_KEY") || "");
        const context = readYtcfgValue("INNERTUBE_CONTEXT") as
          | {
              client?: {
                clientName?: string;
                clientVersion?: string;
                visitorData?: string;
              };
            }
          | null;

        if (!params || !apiKey || !context) {
          return null;
        }

        const response = await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "X-YouTube-Client-Name": String(context.client?.clientName || "1"),
            "X-YouTube-Client-Version": String(context.client?.clientVersion || ""),
            "X-Goog-Visitor-Id": String(context.client?.visitorData || "")
          },
          body: JSON.stringify({
            context,
            params
          })
        });

        if (!response.ok) {
          return null;
        }

        const data = await response.json();
        const segments = parseTranscriptSegments(data);

        return segments.length > 0 ? segments : null;
      }

      const playerResponse = (await readPlayerResponse()) as
        | {
            captions?: {
              playerCaptionsTracklistRenderer?: {
                captionTracks?: PageCaptionTrack[];
              };
            };
          }
        | null;
      const captionTracks =
        playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      const selectedTrack = chooseEnglishCaptionTrack(captionTracks);

      if (!selectedTrack?.baseUrl || typeof selectedTrack.baseUrl !== "string") {
        return {
          ok: false,
          errorCode: "NO_ENGLISH_CAPTIONS",
          message: "当前视频无法解析：没有可获取的英文字幕。"
        };
      }

      const captionUrl = new URL(selectedTrack.baseUrl);
      captionUrl.searchParams.set("fmt", "json3");

      const response = await fetch(captionUrl.toString(), {
        credentials: "include"
      });

      if (!response.ok) {
        return {
          ok: false,
          errorCode: "CAPTION_REQUEST_FAILED",
          message: "当前视频无法解析：英文字幕请求失败。"
        };
      }

      const text = await response.text();

      if (!text.trim()) {
        const transcriptSegments = await fetchTranscriptSegments();

        if (transcriptSegments) {
          return {
            ok: true,
            payload: {
              track: {
                languageCode: String(selectedTrack.languageCode || "en"),
                name: "English transcript",
                kind: String(selectedTrack.kind || "standard")
              },
              segments: transcriptSegments
            }
          };
        }

        return {
          ok: false,
          errorCode: "EMPTY_CAPTION_RESPONSE",
          message: "当前视频无法解析：英文字幕接口返回空内容。"
        };
      }

      let data: {
        events?: Array<{
          tStartMs?: number;
          dDurationMs?: number;
          segs?: Array<{ utf8?: string }>;
        }>;
      };

      try {
        data = JSON.parse(text);
      } catch {
        return {
          ok: false,
          errorCode: "CAPTION_PARSE_FAILED",
          message: "当前视频无法解析：英文字幕格式解析失败。"
        };
      }

      const segments = (data.events || [])
        .map((event) => {
          const captionText = normalizeCaptionText(
            (event.segs || []).map((segment) => segment.utf8 || "").join("")
          );
          const startTime = Number(event.tStartMs) / 1000;
          const duration = Number(event.dDurationMs || 0) / 1000;

          return {
            startTime,
            endTime: startTime + duration,
            text: captionText
          };
        })
        .filter(
          (segment) =>
            segment.text && Number.isFinite(segment.startTime) && Number.isFinite(segment.endTime)
        );

      if (segments.length === 0) {
        return {
          ok: false,
          errorCode: "EMPTY_CAPTIONS",
          message: "当前视频无法解析：英文字幕内容为空。"
        };
      }

      return {
        ok: true,
        payload: {
          track: {
            languageCode: String(selectedTrack.languageCode || ""),
            name:
              selectedTrack.name?.simpleText ||
              selectedTrack.name?.runs?.map((run) => run.text || "").join("") ||
              "",
            kind: String(selectedTrack.kind || "standard")
          },
          segments
        }
      };
    }
  });

  return (
    (executionResults[0]?.result as EnglishCaptionsResult | undefined) || {
      ok: false,
      errorCode: "CAPTION_SCRIPT_NO_RESULT",
      message: "当前视频无法解析：英文字幕脚本没有返回结果。"
    }
  );
}

async function requestEnglishCaptions(tabId: number): Promise<EnglishCaptionsResult> {
  const pageWorldResult = await requestEnglishCaptionsFromPageWorld(tabId);

  if (pageWorldResult.ok) {
    return pageWorldResult;
  }

  try {
    const contentScriptResult = (await chrome.tabs.sendMessage(tabId, {
      type: ENGLISH_CAPTIONS_REQUEST
    })) as EnglishCaptionsResult;

    if (contentScriptResult.ok) {
      return contentScriptResult;
    }
  } catch {
    // The main-world attempt gives the more relevant failure reason.
  }

  return pageWorldResult;
}

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createMockChatItem(question: string): MockChatItem {
  return {
    id: createId("chat"),
    question,
    answer:
      "这段内容强调的是：在使用 AI 编程工具时，清晰的上下文会直接影响输出质量。对产品经理来说，可以把它理解成先定义问题、边界和验收标准，再让 AI 执行。"
  };
}

function createMockNoteItem(segment: SubtitleSegment, selectedText: string): MockNoteItem {
  return {
    id: createId("note"),
    sourceText: selectedText,
    sourceTranslation: segment.chineseText,
    userComment: "",
    startTime: segment.startTime,
    endTime: segment.endTime,
    isSaved: false
  };
}

function createMockOrganizedNote(sourceText: string) {
  return `这段内容可以整理为：${sourceText}。核心意思是先把上下文和规则说清楚，再让 AI 执行具体任务。`;
}

function createMockVocabularyItems(segment: SubtitleSegment, selectedText: string): MockVocabularyItem[] {
  const lowerText = selectedText.toLowerCase();
  const candidates: Array<Omit<MockVocabularyItem, "id" | "sourceSentence" | "sourceTranslation">> = [];

  if (lowerText.includes("context")) {
    candidates.push({
      text: "context",
      type: "word",
      meaningZh: "上下文；背景信息",
      example: {
        en: "The model needs enough context to produce a useful answer.",
        zh: "模型需要足够的上下文，才能生成有用的回答。"
      }
    });
  }

  if (lowerText.includes("permission")) {
    candidates.push({
      text: "permission management",
      type: "phrase",
      meaningZh: "权限管理",
      example: {
        en: "Permission management keeps the workflow controlled and predictable.",
        zh: "权限管理让工作流更可控、更可预期。"
      }
    });
  }

  if (lowerText.includes("workflow")) {
    candidates.push({
      text: "workflow",
      type: "word",
      meaningZh: "工作流；流程",
      example: {
        en: "A visible workflow helps beginners verify progress step by step.",
        zh: "可见的工作流能帮助初学者逐步验证进展。"
      }
    });
  }

  if (candidates.length === 0) {
    candidates.push(
      {
        text: "explicit",
        type: "word",
        meaningZh: "明确的；清楚表达的",
        example: {
          en: "Make the acceptance criteria explicit before implementation.",
          zh: "在实现之前，把验收标准明确写出来。"
        }
      },
      {
        text: "visible step",
        type: "phrase",
        meaningZh: "可见步骤",
        example: {
          en: "One visible step at a time makes the project easier to validate.",
          zh: "一次一个可见步骤，会让项目更容易验证。"
        }
      }
    );
  }

  return candidates.slice(0, 3).map((candidate) => ({
    ...candidate,
    id: createId("vocab"),
    sourceSentence: segment.englishText,
    sourceTranslation: segment.chineseText
  }));
}

function getGenerationSourceLabel(source: GenerationSource) {
  if (source === "ai") {
    return "DeepSeek AI";
  }

  if (source === "failed") {
    return "生成失败";
  }

  if (source === "partial") {
    return "部分完成";
  }

  return "Mock / 历史缓存";
}

function getChatSourceLabel(source: ChatSource | undefined) {
  if (source === "loading") {
    return "DeepSeek AI 生成中";
  }

  if (source === "ai") {
    return "DeepSeek AI 回复";
  }

  if (source === "failed") {
    return "生成失败";
  }

  return "Mock AI 回复";
}

function getChatSourceClassName(source: ChatSource | undefined) {
  if (source === "loading") {
    return "text-[#4f6b4a]";
  }

  if (source === "failed") {
    return "text-[#9a5a2f]";
  }

  if (source === "ai") {
    return "text-[#4f6b4a]";
  }

  return "text-[#6c7568]";
}

function getVocabularyTypeFromText(text: string): "word" | "phrase" {
  return /\s/.test(text.trim()) ? "phrase" : "word";
}

function getReadableAuthErrorMessage(message: string) {
  const normalizedMessage = message.toLowerCase();

  if (normalizedMessage.includes("email rate limit") || normalizedMessage.includes("rate limit")) {
    return "验证码发送太频繁，请稍后再试。为避免继续触发限流，发送按钮会暂时禁用。";
  }

  if (normalizedMessage.includes("token") || normalizedMessage.includes("otp")) {
    return "验证码无效或已过期，请检查后重试。";
  }

  return message;
}

function getVideoPageState(
  videoInfo: VideoInfo,
  parsingVideoId: string | null,
  learnedVideoId: string | null
): PanelState {
  if (!videoInfo.isYouTubeVideoPage || !videoInfo.videoId) {
    return {
      status: "unparseable",
      reason: "当前视频无法解析",
      detail: "当前页面不是 YouTube 视频播放页。",
      url: videoInfo.url,
      videoInfo
    };
  }

  if (!videoInfo.title) {
    return {
      status: "unparseable",
      reason: "当前视频无法解析",
      detail: "未能读取视频标题，请刷新页面后重试。",
      url: videoInfo.url,
      videoInfo
    };
  }

  if (videoInfo.durationSeconds === null) {
    return {
      status: "unparseable",
      reason: "当前视频无法解析",
      detail: "暂时无法获取当前视频时长，无法开始解析。",
      url: videoInfo.url,
      videoInfo
    };
  }

  if (videoInfo.durationSeconds > 3600) {
    return {
      status: "unparseable",
      reason: "当前视频无法解析",
      detail: "当前视频时长超过 60 分钟，MVP 暂只支持 60 分钟以内的视频解析。",
      url: videoInfo.url,
      videoInfo
    };
  }

  if (learnedVideoId === videoInfo.videoId) {
    return { status: "learning", videoInfo };
  }

  if (parsingVideoId === videoInfo.videoId) {
    return { status: "parsing", videoInfo };
  }

  return { status: "readyToParse", videoInfo };
}

function assertTranscriptCoverage(videoInfo: VideoInfo, segments: RawCaptionSegment[]) {
  if (!videoInfo.durationSeconds || videoInfo.durationSeconds <= 60) {
    return;
  }

  const lastSubtitleEndTime = Math.max(...segments.map((segment) => segment.endTime));

  if (!Number.isFinite(lastSubtitleEndTime) || lastSubtitleEndTime < videoInfo.durationSeconds * 0.75) {
    throw new Error("当前视频无法解析：获取到的英文字幕正文不完整。");
  }
}

function canRetryParsingFromUnparseableState(panelState: PanelState) {
  if (panelState.status !== "unparseable" || !panelState.videoInfo) {
    return false;
  }

  return (
    panelState.videoInfo.isYouTubeVideoPage &&
    Boolean(panelState.videoInfo.videoId) &&
    Boolean(panelState.videoInfo.title) &&
    panelState.videoInfo.durationSeconds !== null &&
    panelState.videoInfo.durationSeconds <= 3600
  );
}

async function translateSubtitleBatchWithRetry(batch: SubtitleTranslationBatch) {
  try {
    return await translateSubtitleBatch(batch);
  } catch (error) {
    if (!isRetriableAiTaskError(error)) {
      throw error;
    }
  }

  try {
    return await translateSubtitleBatch(batch);
  } catch (error) {
    if (isRetriableAiTaskError(error)) {
      throw new Error(`字幕翻译失败：第 ${batch.batchIndex + 1} 批字幕生成不稳定，请稍后点击重新解析。`);
    }

    throw error;
  }
}

function App() {
  const [panelState, setPanelState] = React.useState<PanelState>({ status: "identifying" });
  const [parseStepStatuses, setParseStepStatuses] = React.useState(createInitialParseStepStatuses);
  const [parseProgressDetail, setParseProgressDetail] = React.useState("");
  const [parseCheckpoint, setParseCheckpoint] = React.useState<VideoParseCheckpoint | null>(null);
  const [activeLearningTab, setActiveLearningTab] = React.useState<LearningTabKey>("overview");
  const [currentPlaybackTime, setCurrentPlaybackTime] = React.useState<number | null>(null);
  const [selectedSubtitle, setSelectedSubtitle] = React.useState<SelectedSubtitle | null>(null);
  const [learningOverview, setLearningOverview] = React.useState<LearningOverview | null>(mockOverview);
  const [subtitleSegments, setSubtitleSegments] = React.useState<SubtitleSegment[]>(mockSubtitleSegments);
  const [overviewSource, setOverviewSource] = React.useState<GenerationSource>("mock");
  const [subtitleSource, setSubtitleSource] = React.useState<GenerationSource>("mock");
  const [overviewGenerationFailed, setOverviewGenerationFailed] = React.useState(false);
  const [vocabularyGenerationFailed, setVocabularyGenerationFailed] = React.useState(false);
  const [vocabularyGenerating, setVocabularyGenerating] = React.useState(false);
  const [chatDraft, setChatDraft] = React.useState("");
  const [mockChatItems, setMockChatItems] = React.useState<MockChatItem[]>([]);
  const [mockNoteItems, setMockNoteItems] = React.useState<MockNoteItem[]>([]);
  const [mockVocabularyItems, setMockVocabularyItems] = React.useState<MockVocabularyItem[]>([]);
  const [authUser, setAuthUser] = React.useState<SupabaseUser | null>(null);
  const [authLoading, setAuthLoading] = React.useState(isSupabaseConfigured);
  const [authMessage, setAuthMessage] = React.useState("");
  const [authError, setAuthError] = React.useState("");
  const [cloudSyncStatus, setCloudSyncStatus] = React.useState<CloudSyncStatus>("idle");
  const [cloudSyncMessage, setCloudSyncMessage] = React.useState("");
  const parsingVideoIdRef = React.useRef<string | null>(null);
  const learnedVideoIdRef = React.useRef<string | null>(null);
  const currentVideoIdRef = React.useRef<string | null>(null);
  const loadedVideoIdRef = React.useRef<string | null>(null);
  const recognizedVideoIdRef = React.useRef<string | null>(null);
  const captionFailureByVideoIdRef = React.useRef<Record<string, string>>({});
  const suppressNextStorageSaveRef = React.useRef(false);
  const cloudLoadKeyRef = React.useRef<string | null>(null);
  const parseTimeoutIdsRef = React.useRef<number[]>([]);
  const learningVideoId = panelState.status === "learning" ? panelState.videoInfo.videoId : null;
  const learningVideoInfo = panelState.status === "learning" ? panelState.videoInfo : null;
  const currentVideoInfo = "videoInfo" in panelState ? panelState.videoInfo : null;

  React.useEffect(() => {
    if ("videoInfo" in panelState) {
      currentVideoIdRef.current = panelState.videoInfo?.videoId ?? null;
      return;
    }

    currentVideoIdRef.current = null;
  }, [panelState]);

  React.useEffect(() => {
    const client = supabase;

    if (!client) {
      setAuthLoading(false);
      return;
    }

    let disposed = false;

    client.auth.getSession().then(({ data }) => {
      if (!disposed) {
        setAuthUser(data.session?.user ?? null);
        setAuthLoading(false);
      }
    });

    const {
      data: { subscription }
    } = client.auth.onAuthStateChange((_event, session) => {
      setAuthUser(session?.user ?? null);
      setAuthLoading(false);
    });

    return () => {
      disposed = true;
      subscription.unsubscribe();
    };
  }, []);

  React.useEffect(() => {
    if (!learningVideoId) {
      suppressNextStorageSaveRef.current = false;
      return;
    }

    if (subtitleSource === "partial") {
      return;
    }

    if (suppressNextStorageSaveRef.current) {
      suppressNextStorageSaveRef.current = false;
      return;
    }

    void saveStoredLearningState(learningVideoId, {
      parsed: true,
      overview: learningOverview,
      subtitleSegments,
      overviewSource,
      subtitleSource,
      overviewGenerationFailed,
      chatItems: mockChatItems.filter((item) => item.source !== "loading"),
      noteItems: mockNoteItems,
      vocabularyItems: mockVocabularyItems,
      updatedAt: Date.now()
    });
  }, [
    learningVideoId,
    learningOverview,
    subtitleSegments,
    overviewSource,
    subtitleSource,
    overviewGenerationFailed,
    mockChatItems,
    mockNoteItems,
    mockVocabularyItems
  ]);

  React.useEffect(() => {
    if (!authUser || !currentVideoInfo?.videoId || panelState.status === "identifying" || panelState.status === "parsing") {
      if (!authUser) {
        cloudLoadKeyRef.current = null;
      }
      return;
    }

    const loadKey = `${authUser.id}:${currentVideoInfo.videoId}`;

    if (cloudLoadKeyRef.current === loadKey) {
      return;
    }

    cloudLoadKeyRef.current = loadKey;
    let disposed = false;
    setCloudSyncStatus("syncing");
    setCloudSyncMessage("正在读取 Supabase 学习记录。");

    loadCloudLearningState(authUser.id, currentVideoInfo)
      .then((cloudLearningState) => {
        if (disposed) {
          return;
        }

        if (cloudLearningState) {
          learnedVideoIdRef.current = currentVideoInfo.videoId;
          setParseStepStatuses(createCompletedParseStepStatuses());
          setLearningOverview(cloudLearningState.overview ?? mockOverview);
          setSubtitleSegments(mockSubtitleSegments);
          setOverviewSource(cloudLearningState.overview ? "ai" : "mock");
          setSubtitleSource("mock");
          setOverviewGenerationFailed(false);
          setMockChatItems(cloudLearningState.chatItems);
          setMockNoteItems(cloudLearningState.noteItems);
          setMockVocabularyItems(cloudLearningState.vocabularyItems);

          if (cloudLearningState.parsed) {
            setActiveLearningTab("overview");
            setPanelState({ status: "learning", videoInfo: currentVideoInfo });
          }
        }

        setCloudSyncStatus("synced");
        setCloudSyncMessage(cloudLearningState ? "已读取 Supabase 学习记录。" : "当前视频暂无云端学习记录。");
      })
      .catch(() => {
        if (!disposed) {
          setCloudSyncStatus("error");
          setCloudSyncMessage("读取 Supabase 失败，请确认 migration 已执行且 RLS 配置正确。");
        }
      });

    return () => {
      disposed = true;
    };
  }, [authUser, currentVideoInfo, panelState.status]);

  React.useEffect(() => {
    if (!authUser || !learningVideoInfo?.videoId) {
      return;
    }

    if (subtitleSource === "partial") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setCloudSyncStatus("syncing");
      setCloudSyncMessage("正在同步到 Supabase。");

      saveCloudLearningState(authUser.id, learningVideoInfo, {
        overview: learningOverview,
        chatItems: mockChatItems.filter((item) => item.source !== "loading"),
        noteItems: mockNoteItems,
        vocabularyItems: mockVocabularyItems
      })
        .then(() => {
          setCloudSyncStatus("synced");
          setCloudSyncMessage("已同步到 Supabase。");
        })
        .catch(() => {
          setCloudSyncStatus("error");
          setCloudSyncMessage("同步 Supabase 失败，本地 chrome.storage 数据仍会保留。");
        });
    }, 800);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [authUser, learningVideoId, learningOverview, subtitleSource, mockChatItems, mockNoteItems, mockVocabularyItems]);

  React.useEffect(() => {
    let disposed = false;

    function clearParseTimers() {
      parseTimeoutIdsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
      parseTimeoutIdsRef.current = [];
    }

    function resetLearningDataForCurrentVideo() {
      setActiveLearningTab("overview");
      setSelectedSubtitle(null);
      setParseProgressDetail("");
      setParseCheckpoint(null);
      setLearningOverview(mockOverview);
      setSubtitleSegments(mockSubtitleSegments);
      setOverviewSource("mock");
      setSubtitleSource("mock");
      setOverviewGenerationFailed(false);
      setVocabularyGenerationFailed(false);
      setVocabularyGenerating(false);
      setChatDraft("");
      setMockChatItems([]);
      setMockNoteItems([]);
      setMockVocabularyItems([]);
    }

    function resetRecognizedVideo() {
      loadedVideoIdRef.current = null;
      recognizedVideoIdRef.current = null;
      parsingVideoIdRef.current = null;
      learnedVideoIdRef.current = null;
      setCurrentPlaybackTime(null);
      resetLearningDataForCurrentVideo();
    }

    async function applyVideoInfo(videoInfo: VideoInfo) {
      const nextState = getVideoPageState(videoInfo, parsingVideoIdRef.current, learnedVideoIdRef.current);

      if (nextState.status === "unparseable" || !videoInfo.videoId) {
        loadedVideoIdRef.current = null;
        recognizedVideoIdRef.current = null;
        setPanelState(nextState);
        return;
      }

      recognizedVideoIdRef.current = videoInfo.videoId;

      const captionFailureDetail = captionFailureByVideoIdRef.current[videoInfo.videoId];

      if (
        captionFailureDetail &&
        parsingVideoIdRef.current !== videoInfo.videoId &&
        learnedVideoIdRef.current !== videoInfo.videoId
      ) {
        setPanelState({
          status: "unparseable",
          reason: "当前视频无法解析",
          detail: captionFailureDetail,
          videoInfo
        });
        return;
      }

      if (parsingVideoIdRef.current === videoInfo.videoId) {
        setPanelState(nextState);
        return;
      }

      if (loadedVideoIdRef.current !== videoInfo.videoId) {
        loadedVideoIdRef.current = videoInfo.videoId;
        suppressNextStorageSaveRef.current = true;
        setPanelState({ status: "identifying" });
        setCurrentPlaybackTime(null);
        resetLearningDataForCurrentVideo();

        const storedLearningState = await loadStoredLearningState(videoInfo.videoId);

        if (disposed || recognizedVideoIdRef.current !== videoInfo.videoId) {
          return;
        }

        if (storedLearningState) {
          learnedVideoIdRef.current = videoInfo.videoId;
          setParseStepStatuses(createCompletedParseStepStatuses());
          setLearningOverview(storedLearningState.overview ?? mockOverview);
          setSubtitleSegments(storedLearningState.subtitleSegments ?? mockSubtitleSegments);
          setOverviewSource(storedLearningState.overviewSource ?? (storedLearningState.overview ? "ai" : "mock"));
          setSubtitleSource(storedLearningState.subtitleSource ?? (storedLearningState.subtitleSegments ? "ai" : "mock"));
          setOverviewGenerationFailed(Boolean(storedLearningState.overviewGenerationFailed));
          setMockChatItems(storedLearningState.chatItems);
          setMockNoteItems(storedLearningState.noteItems);
          setMockVocabularyItems(storedLearningState.vocabularyItems);
          setActiveLearningTab("overview");
          setPanelState({ status: "learning", videoInfo });
          return;
        }

        const storedParseCheckpoint = await loadParseCheckpoint(videoInfo.videoId);

        if (disposed || recognizedVideoIdRef.current !== videoInfo.videoId) {
          return;
        }

        if (storedParseCheckpoint) {
          const checkpointSegments = mergeCompletedBatchResults(storedParseCheckpoint.completedBatchResults);
          setParseCheckpoint(storedParseCheckpoint);
          setSubtitleSegments(checkpointSegments);
          setSubtitleSource(checkpointSegments.length > 0 ? "partial" : "mock");
          setLearningOverview(null);
          setOverviewSource("failed");
          setOverviewGenerationFailed(checkpointSegments.length > 0);
          setParseStepStatuses({
            ...createInitialParseStepStatuses(),
            fetch_captions: "completed",
            segment_subtitles: checkpointSegments.length > 0 ? "completed" : "pending",
            translate_subtitles:
              storedParseCheckpoint.status === "completed"
                ? "completed"
                : storedParseCheckpoint.completedBatchResults.length > 0
                  ? "failed"
                  : "pending"
          });

          if (checkpointSegments.length > 0) {
            learnedVideoIdRef.current = videoInfo.videoId;
            setActiveLearningTab("subtitles");
            setPanelState({ status: "learning", videoInfo });
            return;
          }
        }

        learnedVideoIdRef.current = null;
        setParseStepStatuses(createInitialParseStepStatuses());
        setPanelState(getVideoPageState(videoInfo, parsingVideoIdRef.current, learnedVideoIdRef.current));
        return;
      }

      setPanelState(nextState);
    }

    async function refreshCurrentTab() {
      try {
        const activeTab = await getActiveTab();
        const activeTabUrl = activeTab?.url;

        if (!activeTab?.id) {
          if (!disposed) {
            clearParseTimers();
            resetRecognizedVideo();
            setPanelState({
              status: "unparseable",
              reason: "当前视频无法解析",
              detail: "未能读取当前标签页，请重新打开 Side Panel。"
            });
          }
          return;
        }

        if (!isYouTubeUrl(activeTabUrl)) {
          if (!disposed) {
            clearParseTimers();
            resetRecognizedVideo();
            setPanelState({
              status: "unparseable",
              reason: "当前视频无法解析",
              detail: "当前页面不是 YouTube 视频页，Video Insight MVP 暂只支持 YouTube 视频。",
              url: activeTabUrl
            });
          }
          return;
        }

        if (!isYouTubeWatchUrl(activeTabUrl)) {
          if (!disposed) {
            clearParseTimers();
            resetRecognizedVideo();
            setPanelState({
              status: "unparseable",
              reason: "当前视频无法解析",
              detail: "当前 YouTube 页面不是视频播放页，请打开具体视频后使用。",
              url: activeTabUrl
            });
          }
          return;
        }

        try {
          const response = await requestVideoInfo(activeTab.id);
          if (!disposed) {
            await applyVideoInfo(response.payload);
          }
        } catch {
          if (!disposed) {
            clearParseTimers();
            resetRecognizedVideo();
            setPanelState({
              status: "unparseable",
              reason: "当前视频无法解析",
              detail: "暂时无法读取当前视频信息，请刷新页面后重试。",
              url: activeTabUrl
            });
          }
        }
      } catch {
        if (!disposed) {
          clearParseTimers();
          resetRecognizedVideo();
          setPanelState({
            status: "unparseable",
            reason: "当前视频无法解析",
            detail: "未能识别当前页面，请重新打开 Side Panel。"
          });
        }
      }
    }

    function handleRuntimeMessage(message: {
      type?: string;
      payload?: VideoInfo | PlaybackTimePayload;
    }) {
      if (message.type === PLAYBACK_TIME_UPDATED) {
        const playbackPayload = message.payload as PlaybackTimePayload | undefined;

        if (playbackPayload?.videoId && playbackPayload.videoId === currentVideoIdRef.current) {
          setCurrentPlaybackTime(playbackPayload.currentTime);
        }

        return;
      }

      if (message.type !== VIDEO_INFO_UPDATED || !(message.payload as VideoInfo | undefined)?.isYouTubeVideoPage) {
        return;
      }

      const videoInfoPayload = message.payload as VideoInfo;
      void applyVideoInfo(videoInfoPayload);
    }

    refreshCurrentTab();
    const intervalId = window.setInterval(refreshCurrentTab, 1500);
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);

    return () => {
      disposed = true;
      clearParseTimers();
      window.clearInterval(intervalId);
      chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
    };
  }, []);

  async function handleStartParsing(
    videoInfo: VideoInfo,
    options: { resumeFromCheckpoint?: boolean } = {}
  ) {
    if (!videoInfo.videoId) {
      return;
    }

    const videoId = videoInfo.videoId;
    parseTimeoutIdsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    parseTimeoutIdsRef.current = [];
    learnedVideoIdRef.current = null;
    parsingVideoIdRef.current = videoId;
    delete captionFailureByVideoIdRef.current[videoId];
    setLearningOverview(null);
    setSubtitleSegments([]);
    setOverviewSource("failed");
    setSubtitleSource("mock");
    setOverviewGenerationFailed(false);
    setVocabularyGenerationFailed(false);
    setVocabularyGenerating(false);
    setParseProgressDetail("");
    setParseCheckpoint(null);
    setParseStepStatuses(createInitialParseStepStatuses());
    setPanelState({ status: "parsing", videoInfo });

    function setStepsStatus(stepKeys: string[], status: ParseStepStatus) {
      setParseStepStatuses((currentStatuses) => {
        const nextStatuses = { ...currentStatuses };

        stepKeys.forEach((stepKey) => {
          nextStatuses[stepKey] = status;
        });

        return nextStatuses;
      });
    }

    try {
      let checkpoint = options.resumeFromCheckpoint ? await loadParseCheckpoint(videoId) : null;

      if (!checkpoint) {
        if (!options.resumeFromCheckpoint) {
          await removeParseCheckpoint(videoId);
        }

        setStepsStatus(["fetch_captions"], "processing");
        const transcript = await fetchTranscriptWithCaptionProvider({
          videoUrl: videoInfo.url,
          videoId,
          language: "en"
        });
        assertTranscriptCoverage(videoInfo, transcript.segments);

        setStepsStatus(["fetch_captions"], "completed");
        setStepsStatus(["segment_subtitles", "translate_subtitles"], "processing");

        setParseProgressDetail("正在重切分字幕并准备翻译批次。");
        const translationBatches = await prepareSubtitleTranslationBatches(transcript.segments);

        checkpoint = {
          videoInfo,
          batches: translationBatches,
          completedBatchResults: [],
          failedBatchIndexes: [],
          status: "translating",
          updatedAt: Date.now()
        };
        setParseCheckpoint(checkpoint);
        await saveParseCheckpoint(videoId, checkpoint);
      } else {
        setParseCheckpoint(checkpoint);
        setStepsStatus(["fetch_captions", "segment_subtitles"], "completed");
        setStepsStatus(["translate_subtitles"], "processing");
        const checkpointSegments = mergeCompletedBatchResults(checkpoint.completedBatchResults);
        setSubtitleSegments(checkpointSegments);
        setSubtitleSource(checkpointSegments.length > 0 ? "partial" : "mock");
      }

      const translationBatches = checkpoint.batches;

      if (translationBatches.length === 0) {
        throw new Error("当前视频无法解析：英文字幕内容为空。");
      }

      let completedBatchResults: CompletedBatchResult[] = checkpoint.completedBatchResults;
      const pendingBatchIndexes = getPendingBatchIndexes(
        translationBatches,
        checkpoint.completedBatchResults,
        checkpoint.failedBatchIndexes
      );
      const pendingBatches = translationBatches.filter((batch) => pendingBatchIndexes.includes(batch.batchIndex));
      let completedCount = completedBatchResults.length;
      let failedBatchIndexes: number[] = [];

      setParseProgressDetail(
        pendingBatches.length > 0
          ? `字幕翻译：已完成 ${completedCount} / ${translationBatches.length} 批，并发 ${SUBTITLE_TRANSLATION_CONCURRENCY} 批处理中。`
          : `字幕翻译：已完成 ${completedCount} / ${translationBatches.length} 批。`
      );

      if (pendingBatches.length > 0) {
        const queueResult = await runSubtitleBatchQueue({
          batches: pendingBatches,
          concurrency: SUBTITLE_TRANSLATION_CONCURRENCY,
          initialCompletedBatchResults: completedBatchResults,
          translateBatch: translateSubtitleBatchWithRetry,
          onBatchComplete: async (result) => {
            if (parsingVideoIdRef.current !== videoId) {
              return;
            }

            completedBatchResults = upsertCompletedBatchResult(completedBatchResults, result);
            completedCount = completedBatchResults.length;
            const mergedSegments = mergeCompletedBatchResults(completedBatchResults);
            const nextCheckpoint: VideoParseCheckpoint = {
              videoInfo,
              batches: translationBatches,
              completedBatchResults,
              failedBatchIndexes,
              status: "translating",
              updatedAt: Date.now()
            };
            setParseCheckpoint(nextCheckpoint);
            setSubtitleSegments(mergedSegments);
            setSubtitleSource("partial");
            setParseProgressDetail(
              `字幕翻译：已完成 ${completedCount} / ${translationBatches.length} 批，并发 ${SUBTITLE_TRANSLATION_CONCURRENCY} 批处理中。`
            );
            await saveParseCheckpoint(videoId, nextCheckpoint);
          },
          onBatchFailed: async (batchIndex) => {
            failedBatchIndexes = [...new Set([...failedBatchIndexes, batchIndex])].sort((left, right) => left - right);
            const nextCheckpoint: VideoParseCheckpoint = {
              videoInfo,
              batches: translationBatches,
              completedBatchResults,
              failedBatchIndexes,
              status: completedBatchResults.length > 0 ? "partially_completed" : "failed",
              updatedAt: Date.now()
            };
            setParseCheckpoint(nextCheckpoint);
            await saveParseCheckpoint(videoId, nextCheckpoint);
          }
        });

        completedBatchResults = queueResult.completedBatchResults;
        failedBatchIndexes = queueResult.failedBatchIndexes;
      }

      if (parsingVideoIdRef.current !== videoId) {
        return;
      }

      const generatedSegments = mergeCompletedBatchResults(completedBatchResults);

      if (generatedSegments.length === 0) {
        throw new Error("字幕翻译失败：没有成功生成可用字幕，请稍后点击重新解析。");
      }

      if (failedBatchIndexes.length > 0 || completedBatchResults.length < translationBatches.length) {
        const partialCheckpoint: VideoParseCheckpoint = {
          videoInfo,
          batches: translationBatches,
          completedBatchResults,
          failedBatchIndexes,
          status: "partially_completed",
          updatedAt: Date.now()
        };
        await saveParseCheckpoint(videoId, partialCheckpoint);
        setParseCheckpoint(partialCheckpoint);
        setParseProgressDetail("");
        setSubtitleSegments(generatedSegments);
        setSubtitleSource("partial");
        setOverviewGenerationFailed(true);
        setOverviewSource("failed");
        setLearningOverview(null);
        setStepsStatus(["segment_subtitles"], "completed");
        setStepsStatus(["translate_subtitles"], "failed");
        parsingVideoIdRef.current = null;
        learnedVideoIdRef.current = videoId;
        setActiveLearningTab("subtitles");
        setPanelState({ status: "learning", videoInfo });
        return;
      }

      setParseProgressDetail(`字幕翻译：已完成 ${translationBatches.length} / ${translationBatches.length} 批。`);
      setSubtitleSegments(generatedSegments);
      setSubtitleSource("ai");
      setStepsStatus(["segment_subtitles", "translate_subtitles"], "completed");

      try {
        setParseProgressDetail("正在生成视频总览。");
        setStepsStatus(["generate_summary", "generate_chapters_timeline"], "processing");
        const generatedOverview = await generateOverviewForLongVideo(generatedSegments);

        if (parsingVideoIdRef.current !== videoId) {
          return;
        }

        setLearningOverview(generatedOverview);
        setOverviewSource("ai");
        setStepsStatus(["generate_summary", "generate_chapters_timeline"], "completed");
      } catch {
        setOverviewGenerationFailed(true);
        setOverviewSource("failed");
        setLearningOverview(null);
        setStepsStatus(["generate_summary", "generate_chapters_timeline"], "failed");
      }

      setStepsStatus(["save_results"], "processing");
      setParseProgressDetail("正在保存解析结果。");
      setStepsStatus(["save_results"], "completed");
      await removeParseCheckpoint(videoId);
      setParseCheckpoint(null);
      setParseProgressDetail("");
      parsingVideoIdRef.current = null;
      learnedVideoIdRef.current = videoId;
      setActiveLearningTab("overview");
      setPanelState({ status: "learning", videoInfo });
    } catch (error) {
      parsingVideoIdRef.current = null;
      setParseProgressDetail("");
      setSubtitleSource("failed");
      setStepsStatus(["fetch_captions", "segment_subtitles", "translate_subtitles"], "failed");
      const failureDetail =
        error instanceof Error && error.message
          ? error.message
          : "没有成功获取当前视频的英文字幕。Video Insight MVP 暂只支持可获取英文字幕的视频。";
      captionFailureByVideoIdRef.current[videoId] = failureDetail;
      setPanelState({
        status: "unparseable",
        reason: "当前视频无法解析",
        detail: failureDetail,
        videoInfo
      });
    }
  }

  async function handleSeekToTime(timeSeconds: number) {
    const activeTab = await getActiveTab();

    if (!activeTab?.id) {
      return;
    }

    await seekActiveTabToTime(activeTab.id, timeSeconds);
    setCurrentPlaybackTime(timeSeconds);
  }

  async function handleContinueParsing(videoInfo: VideoInfo) {
    await handleStartParsing(videoInfo, { resumeFromCheckpoint: true });
  }

  async function handleCopySelectedSubtitle() {
    if (!selectedSubtitle) {
      return;
    }

    await navigator.clipboard.writeText(selectedSubtitle.text);
    clearSelectedSubtitle();
  }

  function clearSelectedSubtitle() {
    window.getSelection()?.removeAllRanges();
    setSelectedSubtitle(null);
  }

  function handleAskAiFromSubtitle() {
    if (!selectedSubtitle) {
      return;
    }

    setChatDraft(`「${selectedSubtitle.text}」\n\n请结合视频上下文解释这段内容。`);
    setActiveLearningTab("chat");
    clearSelectedSubtitle();
  }

  async function handleSendChatDraft() {
    const trimmedDraft = chatDraft.trim();

    if (!trimmedDraft) {
      return;
    }

    const chatId = createId("chat");
    setChatDraft("");
    setMockChatItems((items) => [
      {
        id: chatId,
        question: trimmedDraft,
        answer: "",
        source: "loading"
      },
      ...items
    ]);

    try {
      const answer = await answerQuestionWithAi({
        question: trimmedDraft,
        videoTitle: learningVideoInfo?.title ?? "",
        overviewSummary: learningOverview?.summary ?? mockOverview.summary,
        subtitles: subtitleSegments,
        recentChat: mockChatItems.slice(0, 4).map((item) => ({
          question: item.question,
          answer: item.answer
        }))
      });

      setMockChatItems((items) =>
        items.map((item) => (item.id === chatId ? { ...item, answer, source: "ai" } : item))
      );
    } catch {
      setMockChatItems((items) =>
        items.map((item) =>
          item.id === chatId
            ? {
                ...item,
                answer: "生成失败。请确认 ai-tasks Edge Function 已重新部署，并且 DeepSeek API Key 可用。",
                source: "failed"
              }
            : item
        )
      );
    }
  }

  function handleCreateNoteFromSubtitle() {
    if (!selectedSubtitle) {
      return;
    }

    setMockNoteItems((items) => [
      createMockNoteItem(selectedSubtitle.segment, selectedSubtitle.text),
      ...items
    ]);
    setActiveLearningTab("notes");
    clearSelectedSubtitle();
  }

  async function handleAddVocabularyFromSubtitle() {
    if (!selectedSubtitle) {
      return;
    }

    const subtitle = selectedSubtitle;
    setActiveLearningTab("vocabulary");
    clearSelectedSubtitle();
    setVocabularyGenerationFailed(false);
    setVocabularyGenerating(true);

    try {
      const generatedItem = await generateVocabularyItemWithAi({
        selectedText: subtitle.text,
        sourceSentence: subtitle.segment.englishText,
        sourceTranslation: subtitle.segment.chineseText,
        videoContext: learningOverview?.summary ?? mockOverview.summary
      });
      const normalizedText = generatedItem.normalizedText.trim() || subtitle.text;

      setMockVocabularyItems((items) => [
        {
          id: createId("vocab"),
          text: normalizedText,
          type: getVocabularyTypeFromText(normalizedText),
          meaningZh: generatedItem.meaningZh,
          sourceSentence: subtitle.segment.englishText,
          sourceTranslation: subtitle.segment.chineseText,
          generatedExamples: []
        },
        ...items
      ]);
    } catch {
      setVocabularyGenerationFailed(true);
    } finally {
      setVocabularyGenerating(false);
    }
  }

  async function handleGenerateMoreVocabularyExamples(vocabularyItemId: string) {
    const vocabularyItem = mockVocabularyItems.find((item) => item.id === vocabularyItemId);

    if (!vocabularyItem) {
      return;
    }

    setMockVocabularyItems((items) =>
      items.map((item) =>
        item.id === vocabularyItemId
          ? { ...item, examplesGenerating: true, examplesGenerationFailed: false }
          : item
      )
    );

    try {
      const examples = await generateVocabularyExamplesWithAi({
        text: vocabularyItem.text,
        type: vocabularyItem.type,
        meaningZh: vocabularyItem.meaningZh,
        sourceSentence: vocabularyItem.sourceSentence,
        sourceTranslation: vocabularyItem.sourceTranslation,
        videoContext: learningOverview?.summary ?? mockOverview.summary,
        existingExamples: vocabularyItem.generatedExamples ?? []
      });

      setMockVocabularyItems((items) =>
        items.map((item) =>
          item.id === vocabularyItemId
            ? {
                ...item,
                generatedExamples: [...(item.generatedExamples ?? []), ...examples],
                examplesGenerating: false,
                examplesGenerationFailed: false
              }
            : item
        )
      );
    } catch {
      setMockVocabularyItems((items) =>
        items.map((item) =>
          item.id === vocabularyItemId
            ? { ...item, examplesGenerating: false, examplesGenerationFailed: true }
            : item
        )
      );
    }
  }

  function handleUpdateNoteComment(noteId: string, userComment: string) {
    setMockNoteItems((items) =>
      items.map((item) => (item.id === noteId ? { ...item, userComment } : item))
    );
  }

  async function handleOrganizeNote(noteId: string) {
    const noteItem = mockNoteItems.find((item) => item.id === noteId);

    if (!noteItem) {
      return;
    }

    setMockNoteItems((items) =>
      items.map((item) =>
        item.id === noteId ? { ...item, aiOrganizing: true, aiOrganizeFailed: false } : item
      )
    );

    try {
      const organizedText = await organizeNoteWithAi({
        sourceText: noteItem.sourceText,
        sourceTranslation: noteItem.sourceTranslation,
        previousOrganizedText: noteItem.aiOrganizedText
      });

      setMockNoteItems((items) =>
        items.map((item) =>
          item.id === noteId
            ? { ...item, aiOrganizedText: organizedText, aiOrganizeFailed: false, aiOrganizing: false }
            : item
        )
      );
    } catch {
      setMockNoteItems((items) =>
        items.map((item) =>
          item.id === noteId ? { ...item, aiOrganizeFailed: true, aiOrganizing: false } : item
        )
      );
    }
  }

  function handleCancelNote(noteId: string) {
    setMockNoteItems((items) => items.filter((item) => item.id !== noteId));
  }

  function handleSaveNote(noteId: string) {
    setMockNoteItems((items) =>
      items.map((item) => (item.id === noteId ? { ...item, isSaved: true } : item))
    );
  }

  async function handleSendEmailOtp(email: string) {
    const client = supabase;

    if (!client) {
      setAuthError("Supabase 尚未配置，请先根据 .env.example 创建本地 .env。");
      return false;
    }

    setAuthLoading(true);
    setAuthError("");
    setAuthMessage("");

    const { error } = await client.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true
      }
    });

    setAuthLoading(false);

    if (error) {
      setAuthError(getReadableAuthErrorMessage(error.message));
      return false;
    }

    setAuthMessage("验证码已发送，请在邮箱里查看 8 位数字验证码。");
    return true;
  }

  async function handleVerifyEmailOtp(email: string, token: string) {
    const client = supabase;

    if (!client) {
      setAuthError("Supabase 尚未配置，请先根据 .env.example 创建本地 .env。");
      return false;
    }

    setAuthLoading(true);
    setAuthError("");
    setAuthMessage("");

    const { data, error } = await client.auth.verifyOtp({
      email,
      token,
      type: "email"
    });

    setAuthLoading(false);

    if (error) {
      setAuthError(getReadableAuthErrorMessage(error.message));
      return false;
    }

    setAuthUser(data.user ?? null);
    setAuthMessage("登录成功，学习记录会同步到 Supabase。");
    return true;
  }

  async function handleSignOut() {
    const client = supabase;

    if (!client) {
      return;
    }

    setAuthLoading(true);
    setAuthError("");
    setAuthMessage("");
    await client.auth.signOut();
    setAuthUser(null);
    setAuthLoading(false);
    setCloudSyncStatus("idle");
    setCloudSyncMessage("");
    cloudLoadKeyRef.current = null;
  }

  return (
    <main className="min-h-screen bg-[#f7f8f5] px-5 py-6 text-[#20241f]">
      <section className="flex min-h-[calc(100vh-3rem)] flex-col gap-6">
        <header>
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-[#6c7568]">Video Insight</p>
          <h1 className="mt-5 text-2xl font-semibold leading-tight">当前视频学习</h1>
        </header>

        <CloudAuthPanel
          user={authUser}
          isConfigured={isSupabaseConfigured}
          isLoading={authLoading}
          authMessage={authMessage}
          authError={authError}
          cloudSyncStatus={cloudSyncStatus}
          cloudSyncMessage={cloudSyncMessage}
          onSendEmailOtp={handleSendEmailOtp}
          onVerifyEmailOtp={handleVerifyEmailOtp}
          onSignOut={handleSignOut}
        />

        <PanelContent
          panelState={panelState}
          parseStepStatuses={parseStepStatuses}
          parseProgressDetail={parseProgressDetail}
          parseCheckpoint={parseCheckpoint}
          activeLearningTab={activeLearningTab}
          currentPlaybackTime={currentPlaybackTime}
          selectedSubtitle={selectedSubtitle}
          learningOverview={learningOverview}
          subtitleSegments={subtitleSegments}
          overviewSource={overviewSource}
          subtitleSource={subtitleSource}
          overviewGenerationFailed={overviewGenerationFailed}
          vocabularyGenerationFailed={vocabularyGenerationFailed}
          vocabularyGenerating={vocabularyGenerating}
          chatDraft={chatDraft}
          mockChatItems={mockChatItems}
          mockNoteItems={mockNoteItems}
          mockVocabularyItems={mockVocabularyItems}
          onSelectLearningTab={setActiveLearningTab}
          onChatDraftChange={setChatDraft}
          onSendChatDraft={handleSendChatDraft}
          onStartParsing={handleStartParsing}
          onContinueParsing={handleContinueParsing}
          onSeekToTime={handleSeekToTime}
          onSelectSubtitle={setSelectedSubtitle}
          onClearSelectedSubtitle={clearSelectedSubtitle}
          onAskAiFromSubtitle={handleAskAiFromSubtitle}
          onCreateNoteFromSubtitle={handleCreateNoteFromSubtitle}
          onAddVocabularyFromSubtitle={handleAddVocabularyFromSubtitle}
          onGenerateMoreVocabularyExamples={handleGenerateMoreVocabularyExamples}
          onCopySelectedSubtitle={handleCopySelectedSubtitle}
          onUpdateNoteComment={handleUpdateNoteComment}
          onOrganizeNote={handleOrganizeNote}
          onCancelNote={handleCancelNote}
          onSaveNote={handleSaveNote}
        />

        <p className="mt-auto text-sm leading-6 text-[#6c7568]">
          Phase 11 使用当前 YouTube 页面中的英文字幕轨作为解析输入。无可获取英文字幕的视频会显示无法解析。
        </p>
      </section>
    </main>
  );
}

function CloudAuthPanel({
  user,
  isConfigured,
  isLoading,
  authMessage,
  authError,
  cloudSyncStatus,
  cloudSyncMessage,
  onSendEmailOtp,
  onVerifyEmailOtp,
  onSignOut
}: {
  user: SupabaseUser | null;
  isConfigured: boolean;
  isLoading: boolean;
  authMessage: string;
  authError: string;
  cloudSyncStatus: CloudSyncStatus;
  cloudSyncMessage: string;
  onSendEmailOtp: (email: string) => Promise<boolean>;
  onVerifyEmailOtp: (email: string, token: string) => Promise<boolean>;
  onSignOut: () => Promise<void>;
}) {
  const [email, setEmail] = React.useState("");
  const [otpToken, setOtpToken] = React.useState("");
  const [otpEmail, setOtpEmail] = React.useState("");
  const [resendCountdown, setResendCountdown] = React.useState(0);
  const statusText = getCloudSyncStatusText(cloudSyncStatus, cloudSyncMessage);

  React.useEffect(() => {
    if (resendCountdown <= 0) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setResendCountdown((currentCountdown) => Math.max(currentCountdown - 1, 0));
    }, 1000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [resendCountdown]);

  async function handleSendOtp() {
    const normalizedEmail = email.trim();

    if (!normalizedEmail) {
      return;
    }

    const ok = await onSendEmailOtp(normalizedEmail);

    if (ok) {
      setOtpEmail(normalizedEmail);
      setOtpToken("");
      setResendCountdown(60);
      return;
    }

    setResendCountdown(60);
  }

  function handleEmailChange(value: string) {
    setEmail(value);

    if (value.trim() !== otpEmail) {
      setOtpEmail("");
      setOtpToken("");
    }
  }

  async function handleVerifyOtp() {
    const normalizedToken = otpToken.trim();

    if (!otpEmail || !normalizedToken) {
      return;
    }

    const ok = await onVerifyEmailOtp(otpEmail, normalizedToken);

    if (ok) {
      setOtpToken("");
    }
  }

  if (!isConfigured) {
    return (
      <section className="rounded-lg border border-[#ead8b7] bg-[#fffaf0] p-4 shadow-sm">
        <p className="text-sm font-semibold text-[#9a5a2f]">Supabase 未配置</p>
        <p className="mt-2 text-sm leading-6 text-[#6c7568]">
          本轮只创建了 .env.example。后续创建本地 .env 并填入 Supabase URL 和 anon key 后，登录和云端同步会启用。
        </p>
      </section>
    );
  }

  if (user) {
    return (
      <section className="rounded-lg border border-[#dfe4dc] bg-white/70 p-4 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[#4f6b4a]">已登录</p>
            <p className="mt-1 break-words text-sm leading-6 text-[#20241f]">{user.email}</p>
            {statusText ? <p className="mt-1 text-xs leading-5 text-[#6c7568]">{statusText}</p> : null}
          </div>
          <button
            type="button"
            className="shrink-0 rounded-md border border-[#dfe4dc] px-3 py-2 text-xs font-semibold hover:border-[#4f6b4a] hover:bg-[#eef5e8]"
            disabled={isLoading}
            onClick={onSignOut}
          >
            退出
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-[#dfe4dc] bg-white/70 p-4 shadow-sm">
      <p className="text-sm font-semibold text-[#4f6b4a]">登录后同步学习记录</p>
      <div className="mt-3 flex gap-2">
        <input
          className="min-w-0 flex-1 rounded-md border border-[#dfe4dc] bg-[#fbfcf8] px-3 py-2 text-sm outline-none focus:border-[#4f6b4a]"
          type="email"
          placeholder="输入邮箱"
          value={email}
          onChange={(event) => handleEmailChange(event.target.value)}
        />
        <button
          type="button"
          className="shrink-0 rounded-md bg-[#20241f] px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#c4cabc]"
          disabled={isLoading || resendCountdown > 0 || !email.trim()}
          onClick={handleSendOtp}
        >
          {isLoading ? "发送中" : resendCountdown > 0 ? `${resendCountdown}s` : "发送验证码"}
        </button>
      </div>
      {otpEmail ? (
        <>
          <div className="mt-3 flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-md border border-[#dfe4dc] bg-[#fbfcf8] px-3 py-2 text-sm outline-none focus:border-[#4f6b4a]"
              inputMode="numeric"
            maxLength={8}
            placeholder="输入 8 位验证码"
            value={otpToken}
            onChange={(event) => setOtpToken(event.target.value.replace(/\D/g, "").slice(0, 8))}
          />
            <button
              type="button"
              className="shrink-0 rounded-md border border-[#20241f] px-3 py-2 text-sm font-semibold text-[#20241f] disabled:cursor-not-allowed disabled:border-[#c4cabc] disabled:text-[#9aa392]"
              disabled={isLoading || otpToken.trim().length !== 8}
              onClick={handleVerifyOtp}
            >
              验证登录
            </button>
          </div>
          <p className="mt-2 text-xs leading-5 text-[#6c7568]">
            验证码已发送到 {otpEmail}。没有收到时，请等倒计时结束后再重发。
          </p>
        </>
      ) : null}
      {authMessage ? <p className="mt-2 text-xs leading-5 text-[#4f6b4a]">{authMessage}</p> : null}
      {authError ? <p className="mt-2 text-xs leading-5 text-[#b5533f]">{authError}</p> : null}
    </section>
  );
}

function getCloudSyncStatusText(status: CloudSyncStatus, message: string) {
  if (message) {
    return message;
  }

  if (status === "syncing") {
    return "正在同步。";
  }

  if (status === "synced") {
    return "云端同步已完成。";
  }

  if (status === "error") {
    return "云端同步失败。";
  }

  return "";
}

function PanelContent({
  panelState,
  parseStepStatuses,
  parseProgressDetail,
  parseCheckpoint,
  activeLearningTab,
  currentPlaybackTime,
  selectedSubtitle,
  learningOverview,
  subtitleSegments,
  overviewSource,
  subtitleSource,
  overviewGenerationFailed,
  vocabularyGenerationFailed,
  vocabularyGenerating,
  chatDraft,
  mockChatItems,
  mockNoteItems,
  mockVocabularyItems,
  onSelectLearningTab,
  onChatDraftChange,
  onSendChatDraft,
  onStartParsing,
  onContinueParsing,
  onSeekToTime,
  onSelectSubtitle,
  onClearSelectedSubtitle,
  onAskAiFromSubtitle,
  onCreateNoteFromSubtitle,
  onAddVocabularyFromSubtitle,
  onGenerateMoreVocabularyExamples,
  onCopySelectedSubtitle,
  onUpdateNoteComment,
  onOrganizeNote,
  onCancelNote,
  onSaveNote
}: {
  panelState: PanelState;
  parseStepStatuses: Record<string, ParseStepStatus>;
  parseProgressDetail: string;
  parseCheckpoint: VideoParseCheckpoint | null;
  activeLearningTab: LearningTabKey;
  currentPlaybackTime: number | null;
  selectedSubtitle: SelectedSubtitle | null;
  learningOverview: LearningOverview | null;
  subtitleSegments: SubtitleSegment[];
  overviewSource: GenerationSource;
  subtitleSource: GenerationSource;
  overviewGenerationFailed: boolean;
  vocabularyGenerationFailed: boolean;
  vocabularyGenerating: boolean;
  mockChatItems: MockChatItem[];
  mockNoteItems: MockNoteItem[];
  mockVocabularyItems: MockVocabularyItem[];
  chatDraft: string;
  onSelectLearningTab: (tabKey: LearningTabKey) => void;
  onChatDraftChange: (draft: string) => void;
  onSendChatDraft: () => void | Promise<void>;
  onStartParsing: (videoInfo: VideoInfo) => void | Promise<void>;
  onContinueParsing: (videoInfo: VideoInfo) => void | Promise<void>;
  onSeekToTime: (timeSeconds: number) => void;
  onSelectSubtitle: (selection: SelectedSubtitle) => void;
  onClearSelectedSubtitle: () => void;
  onAskAiFromSubtitle: () => void;
  onCreateNoteFromSubtitle: () => void;
  onAddVocabularyFromSubtitle: () => void;
  onGenerateMoreVocabularyExamples: (vocabularyItemId: string) => void;
  onCopySelectedSubtitle: () => void;
  onUpdateNoteComment: (noteId: string, userComment: string) => void;
  onOrganizeNote: (noteId: string) => void;
  onCancelNote: (noteId: string) => void;
  onSaveNote: (noteId: string) => void;
}) {
  if (panelState.status === "identifying") {
    return <StatusCard title="正在识别当前页面" description="请保持 Side Panel 打开。" />;
  }

  if (panelState.status === "unparseable") {
    const canRetryParsing = canRetryParsingFromUnparseableState(panelState);

    return (
      <StatusCard
        title={panelState.reason}
        description={panelState.detail}
        tone="warning"
        action={
          canRetryParsing
            ? {
                label: "重新解析",
                onClick: () => onStartParsing(panelState.videoInfo as VideoInfo)
              }
            : undefined
        }
      />
    );
  }

  if (panelState.status === "parsing") {
    return (
      <ParsingCard
        videoInfo={panelState.videoInfo}
        parseStepStatuses={parseStepStatuses}
        parseProgressDetail={parseProgressDetail}
      />
    );
  }

  if (panelState.status === "learning") {
    return (
      <LearningView
        videoInfo={panelState.videoInfo}
        activeLearningTab={activeLearningTab}
        currentPlaybackTime={currentPlaybackTime}
        selectedSubtitle={selectedSubtitle}
        learningOverview={learningOverview}
        subtitleSegments={subtitleSegments}
        overviewSource={overviewSource}
        subtitleSource={subtitleSource}
        overviewGenerationFailed={overviewGenerationFailed}
        vocabularyGenerationFailed={vocabularyGenerationFailed}
        vocabularyGenerating={vocabularyGenerating}
        chatDraft={chatDraft}
        mockChatItems={mockChatItems}
        mockNoteItems={mockNoteItems}
        mockVocabularyItems={mockVocabularyItems}
        onSelectLearningTab={onSelectLearningTab}
        onChatDraftChange={onChatDraftChange}
        onSendChatDraft={onSendChatDraft}
        onStartParsing={onStartParsing}
        onContinueParsing={onContinueParsing}
        onSeekToTime={onSeekToTime}
        onSelectSubtitle={onSelectSubtitle}
        onClearSelectedSubtitle={onClearSelectedSubtitle}
        onAskAiFromSubtitle={onAskAiFromSubtitle}
        onCreateNoteFromSubtitle={onCreateNoteFromSubtitle}
        onAddVocabularyFromSubtitle={onAddVocabularyFromSubtitle}
        onGenerateMoreVocabularyExamples={onGenerateMoreVocabularyExamples}
        onCopySelectedSubtitle={onCopySelectedSubtitle}
        onUpdateNoteComment={onUpdateNoteComment}
        onOrganizeNote={onOrganizeNote}
        onCancelNote={onCancelNote}
        onSaveNote={onSaveNote}
      />
    );
  }

  return (
    <ReadyToParseCard
      videoInfo={panelState.videoInfo}
      parseCheckpoint={parseCheckpoint}
      onStartParsing={onStartParsing}
      onContinueParsing={onContinueParsing}
    />
  );
}

function StatusCard({
  title,
  description,
  tone = "neutral",
  action
}: {
  title: string;
  description: string;
  tone?: "neutral" | "warning";
  action?: {
    label: string;
    onClick: () => void | Promise<void>;
  };
}) {
  const toneClassName =
    tone === "warning" ? "border-[#ead8b7] bg-[#fffaf0]" : "border-[#dfe4dc] bg-white/70";

  return (
    <section className={`rounded-lg border p-4 shadow-sm ${toneClassName}`}>
      <p className="text-base font-semibold">{title}</p>
      <p className="mt-2 text-sm leading-6 text-[#6c7568]">{description}</p>
      {action ? (
        <button
          type="button"
          className="mt-4 w-full rounded-md bg-[#20241f] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#343a31]"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ) : null}
    </section>
  );
}

function ReadyToParseCard({
  videoInfo,
  parseCheckpoint,
  onStartParsing,
  onContinueParsing
}: {
  videoInfo: VideoInfo;
  parseCheckpoint: VideoParseCheckpoint | null;
  onStartParsing: (videoInfo: VideoInfo) => void;
  onContinueParsing: (videoInfo: VideoInfo) => void;
}) {
  const hasCheckpointForVideo = parseCheckpoint?.videoInfo.videoId === videoInfo.videoId;
  const completedBatchCount = parseCheckpoint?.completedBatchResults.length ?? 0;
  const totalBatchCount = parseCheckpoint?.batches.length ?? 0;

  return (
    <section className="rounded-lg border border-[#dfe4dc] bg-white/70 p-4 shadow-sm">
      <p className="text-sm font-semibold text-[#4f6b4a]">
        {hasCheckpointForVideo ? "当前视频有未完成解析" : "当前视频可尝试解析"}
      </p>
      <p className="mt-2 text-sm leading-6 text-[#6c7568]">
        {hasCheckpointForVideo
          ? `已保留 ${completedBatchCount} / ${totalBatchCount} 个字幕批次。可以继续解析，也可以从头重新解析。`
          : "已读取视频基础信息。点击下方按钮后，会先获取英文字幕；如果无法获取，会显示无法解析。"}
      </p>
      <VideoSummary videoInfo={videoInfo} />
      {hasCheckpointForVideo ? (
        <button
          type="button"
          className="mt-5 w-full rounded-md bg-[#20241f] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#343a31]"
          onClick={() => onContinueParsing(videoInfo)}
        >
          继续解析
        </button>
      ) : null}
      <button
        type="button"
        className={`w-full rounded-md px-4 py-3 text-sm font-semibold transition ${
          hasCheckpointForVideo
            ? "mt-3 border border-[#20241f] text-[#20241f] hover:bg-[#eef5e8]"
            : "mt-5 bg-[#20241f] text-white hover:bg-[#343a31]"
        }`}
        onClick={() => onStartParsing(videoInfo)}
      >
        {hasCheckpointForVideo ? "重新解析" : "解析当前视频"}
      </button>
    </section>
  );
}

function ParsingCard({
  videoInfo,
  parseStepStatuses,
  parseProgressDetail
}: {
  videoInfo: VideoInfo;
  parseStepStatuses: Record<string, ParseStepStatus>;
  parseProgressDetail: string;
}) {
  const completedCount = MOCK_PARSE_STEPS.filter(
    (step) => parseStepStatuses[step.key] === "completed"
  ).length;
  const hasFailedStep = MOCK_PARSE_STEPS.some((step) => parseStepStatuses[step.key] === "failed");
  const progressPercent = Math.round((completedCount / MOCK_PARSE_STEPS.length) * 100);

  return (
    <section className="rounded-lg border border-[#dfe4dc] bg-white/70 p-4 shadow-sm">
      <p className="text-sm font-semibold text-[#4f6b4a]">解析中</p>
      <p className="mt-2 text-sm leading-6 text-[#6c7568]">
        正在获取当前视频英文字幕，并交给 DeepSeek 重切分、翻译和生成总览。
      </p>
      {parseProgressDetail ? (
        <p className="mt-2 rounded-md border border-[#dfe4dc] bg-[#fbfcf8] px-3 py-2 text-sm font-medium text-[#4f6b4a]">
          {parseProgressDetail}
        </p>
      ) : null}
      <VideoSummary videoInfo={videoInfo} />
      <div className="mt-5 h-2 overflow-hidden rounded-full bg-[#e4e8df]">
        <div
          className="h-full rounded-full bg-[#4f6b4a] transition-all duration-500"
          style={{ width: `${progressPercent}%` }}
        />
      </div>
      <div className="mt-2 text-right text-xs font-medium text-[#6c7568]">{progressPercent}%</div>
      <ol className="mt-5 space-y-3">
        {MOCK_PARSE_STEPS.map((step) => (
          <ParseStepItem key={step.key} label={step.label} status={parseStepStatuses[step.key]} />
        ))}
      </ol>
      {hasFailedStep ? (
        <div className="mt-4">
          <GeneratedFailure title="生成失败" />
        </div>
      ) : null}
    </section>
  );
}

function ParseStepItem({ label, status }: { label: string; status: ParseStepStatus }) {
  const statusConfig: Record<ParseStepStatus, { text: string; className: string; marker: string }> = {
    pending: {
      text: "待处理",
      marker: "bg-[#d6dbd1]",
      className: "text-[#6c7568]"
    },
    processing: {
      text: "处理中",
      marker: "bg-[#4f6b4a]",
      className: "text-[#4f6b4a]"
    },
    completed: {
      text: "已完成",
      marker: "bg-[#20241f]",
      className: "text-[#20241f]"
    },
    failed: {
      text: "失败",
      marker: "bg-[#b5533f]",
      className: "text-[#b5533f]"
    }
  };
  const config = statusConfig[status];

  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-[#edf0ea] bg-[#fbfcf8] px-3 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${config.marker}`} />
        <span className="truncate text-sm font-medium">{label}</span>
      </div>
      <span className={`shrink-0 text-xs font-semibold ${config.className}`}>{config.text}</span>
    </li>
  );
}

function LearningView({
  videoInfo,
  activeLearningTab,
  currentPlaybackTime,
  selectedSubtitle,
  learningOverview,
  subtitleSegments,
  overviewSource,
  subtitleSource,
  overviewGenerationFailed,
  vocabularyGenerationFailed,
  vocabularyGenerating,
  chatDraft,
  mockChatItems,
  mockNoteItems,
  mockVocabularyItems,
  onSelectLearningTab,
  onChatDraftChange,
  onSendChatDraft,
  onStartParsing,
  onContinueParsing,
  onSeekToTime,
  onSelectSubtitle,
  onClearSelectedSubtitle,
  onAskAiFromSubtitle,
  onCreateNoteFromSubtitle,
  onAddVocabularyFromSubtitle,
  onGenerateMoreVocabularyExamples,
  onCopySelectedSubtitle,
  onUpdateNoteComment,
  onOrganizeNote,
  onCancelNote,
  onSaveNote
}: {
  videoInfo: VideoInfo;
  activeLearningTab: LearningTabKey;
  currentPlaybackTime: number | null;
  selectedSubtitle: SelectedSubtitle | null;
  learningOverview: LearningOverview | null;
  subtitleSegments: SubtitleSegment[];
  overviewSource: GenerationSource;
  subtitleSource: GenerationSource;
  overviewGenerationFailed: boolean;
  vocabularyGenerationFailed: boolean;
  vocabularyGenerating: boolean;
  chatDraft: string;
  mockChatItems: MockChatItem[];
  mockNoteItems: MockNoteItem[];
  mockVocabularyItems: MockVocabularyItem[];
  onSelectLearningTab: (tabKey: LearningTabKey) => void;
  onChatDraftChange: (draft: string) => void;
  onSendChatDraft: () => void | Promise<void>;
  onStartParsing: (videoInfo: VideoInfo) => void | Promise<void>;
  onContinueParsing: (videoInfo: VideoInfo) => void | Promise<void>;
  onSeekToTime: (timeSeconds: number) => void;
  onSelectSubtitle: (selection: SelectedSubtitle) => void;
  onClearSelectedSubtitle: () => void;
  onAskAiFromSubtitle: () => void;
  onCreateNoteFromSubtitle: () => void;
  onAddVocabularyFromSubtitle: () => void;
  onGenerateMoreVocabularyExamples: (vocabularyItemId: string) => void;
  onCopySelectedSubtitle: () => void;
  onUpdateNoteComment: (noteId: string, userComment: string) => void;
  onOrganizeNote: (noteId: string) => void;
  onCancelNote: (noteId: string) => void;
  onSaveNote: (noteId: string) => void;
}) {
  return (
    <div className="space-y-4">
      <section className="flex items-center justify-between gap-3 rounded-lg border border-[#dfe4dc] bg-white/70 p-3 text-xs shadow-sm">
        <div className="min-w-0 leading-5 text-[#6c7568]">
          <span className="font-semibold text-[#4f6b4a]">
            {overviewSource === "ai" || subtitleSource === "ai" ? "DeepSeek AI 已参与生成" : "当前展示 Mock / 历史缓存"}
          </span>
          <span className="ml-2">
            字幕：{getGenerationSourceLabel(subtitleSource)} · 总览：{getGenerationSourceLabel(overviewSource)}
          </span>
        </div>
        <div className="flex shrink-0 gap-2">
          {subtitleSource === "partial" ? (
            <button
              type="button"
              className="rounded-md bg-[#20241f] px-3 py-2 font-semibold text-white transition hover:bg-[#343a31]"
              onClick={() => onContinueParsing(videoInfo)}
            >
              继续解析
            </button>
          ) : null}
          <button
            type="button"
            className="rounded-md border border-[#20241f] px-3 py-2 font-semibold text-[#20241f] transition hover:bg-[#eef5e8]"
            onClick={() => onStartParsing(videoInfo)}
          >
            重新解析
          </button>
        </div>
      </section>

      <nav className="grid grid-cols-5 rounded-lg border border-[#dfe4dc] bg-white/70 p-1 shadow-sm">
        {LEARNING_TABS.map((tab) => {
          const isActive = activeLearningTab === tab.key;

          return (
            <button
              key={tab.key}
              type="button"
              className={`rounded-md px-2 py-2 text-sm font-semibold transition ${
                isActive ? "bg-[#20241f] text-white" : "text-[#6c7568] hover:bg-[#eef2ea]"
              }`}
              onClick={() => onSelectLearningTab(tab.key)}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      <section className="rounded-lg border border-[#dfe4dc] bg-white/70 p-4 shadow-sm">
        <LearningTabContent
          activeLearningTab={activeLearningTab}
          videoInfo={videoInfo}
          currentPlaybackTime={currentPlaybackTime}
          learningOverview={learningOverview}
          subtitleSegments={subtitleSegments}
          overviewSource={overviewSource}
          subtitleSource={subtitleSource}
          overviewGenerationFailed={overviewGenerationFailed}
          vocabularyGenerationFailed={vocabularyGenerationFailed}
          vocabularyGenerating={vocabularyGenerating}
          chatDraft={chatDraft}
          mockChatItems={mockChatItems}
          mockNoteItems={mockNoteItems}
          mockVocabularyItems={mockVocabularyItems}
          onChatDraftChange={onChatDraftChange}
          onSendChatDraft={onSendChatDraft}
          onSeekToTime={onSeekToTime}
          onSelectSubtitle={onSelectSubtitle}
          onGenerateMoreVocabularyExamples={onGenerateMoreVocabularyExamples}
          onUpdateNoteComment={onUpdateNoteComment}
          onOrganizeNote={onOrganizeNote}
          onCancelNote={onCancelNote}
          onSaveNote={onSaveNote}
        />
      </section>
      {selectedSubtitle ? (
        <SelectionActionMenu
          selectedSubtitle={selectedSubtitle}
          onAskAi={onAskAiFromSubtitle}
          onCreateNote={onCreateNoteFromSubtitle}
          onAddVocabulary={onAddVocabularyFromSubtitle}
          onCopy={onCopySelectedSubtitle}
          onClose={onClearSelectedSubtitle}
        />
      ) : null}
    </div>
  );
}

function LearningTabContent({
  activeLearningTab,
  videoInfo,
  currentPlaybackTime,
  learningOverview,
  subtitleSegments,
  overviewSource,
  subtitleSource,
  overviewGenerationFailed,
  vocabularyGenerationFailed,
  vocabularyGenerating,
  chatDraft,
  mockChatItems,
  mockNoteItems,
  mockVocabularyItems,
  onChatDraftChange,
  onSendChatDraft,
  onSeekToTime,
  onSelectSubtitle,
  onGenerateMoreVocabularyExamples,
  onUpdateNoteComment,
  onOrganizeNote,
  onCancelNote,
  onSaveNote
}: {
  activeLearningTab: LearningTabKey;
  videoInfo: VideoInfo;
  currentPlaybackTime: number | null;
  learningOverview: LearningOverview | null;
  subtitleSegments: SubtitleSegment[];
  overviewSource: GenerationSource;
  subtitleSource: GenerationSource;
  overviewGenerationFailed: boolean;
  vocabularyGenerationFailed: boolean;
  vocabularyGenerating: boolean;
  chatDraft: string;
  mockChatItems: MockChatItem[];
  mockNoteItems: MockNoteItem[];
  mockVocabularyItems: MockVocabularyItem[];
  onChatDraftChange: (draft: string) => void;
  onSendChatDraft: () => void | Promise<void>;
  onSeekToTime: (timeSeconds: number) => void;
  onSelectSubtitle: (selection: SelectedSubtitle) => void;
  onGenerateMoreVocabularyExamples: (vocabularyItemId: string) => void;
  onUpdateNoteComment: (noteId: string, userComment: string) => void;
  onOrganizeNote: (noteId: string) => void;
  onCancelNote: (noteId: string) => void;
  onSaveNote: (noteId: string) => void;
}) {
  if (activeLearningTab === "overview") {
    return (
      <>
        <VideoSummary videoInfo={videoInfo} />
        <OverviewContent
          overview={learningOverview}
          source={overviewSource}
          hasGenerationFailed={overviewGenerationFailed}
        />
      </>
    );
  }

  if (activeLearningTab === "subtitles") {
    return (
      <SubtitlesContent
        subtitleSegments={subtitleSegments}
        source={subtitleSource}
        currentPlaybackTime={currentPlaybackTime}
        onSeekToTime={onSeekToTime}
        onSelectSubtitle={onSelectSubtitle}
      />
    );
  }

  if (activeLearningTab === "chat") {
    return (
      <ChatContent
        chatDraft={chatDraft}
        chatItems={mockChatItems}
        onChatDraftChange={onChatDraftChange}
        onSendChatDraft={onSendChatDraft}
      />
    );
  }

  if (activeLearningTab === "notes") {
    return (
      <NotesContent
        noteItems={mockNoteItems}
        onUpdateNoteComment={onUpdateNoteComment}
        onOrganizeNote={onOrganizeNote}
        onCancelNote={onCancelNote}
        onSaveNote={onSaveNote}
      />
    );
  }

  return (
    <VocabularyContent
      vocabularyItems={mockVocabularyItems}
      hasGenerationFailed={vocabularyGenerationFailed}
      isGenerating={vocabularyGenerating}
      onGenerateMoreExamples={onGenerateMoreVocabularyExamples}
    />
  );
}

function OverviewContent({
  overview,
  source,
  hasGenerationFailed
}: {
  overview: LearningOverview | null;
  source: GenerationSource;
  hasGenerationFailed: boolean;
}) {
  if (hasGenerationFailed || !overview) {
    return (
      <div className="mt-5">
        <GeneratedFailure title="总览生成失败" />
      </div>
    );
  }

  return (
    <div className="mt-5 space-y-4">
      <p className="text-xs font-semibold text-[#4f6b4a]">总览来源：{getGenerationSourceLabel(source)}</p>
      <GeneratedSection title="视频摘要">
        <p className="text-sm leading-6 text-[#394038]">{overview.summary}</p>
      </GeneratedSection>

      <GeneratedSection title="章节划分">
        <div className="space-y-3">
          {overview.chapters.map((chapter, index) => (
            <article key={chapter.title} className="rounded-md border border-[#edf0ea] bg-[#fbfcf8] p-3">
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-sm font-semibold">
                  {index + 1}. {chapter.title}
                </h3>
                <span className="shrink-0 text-xs font-medium text-[#6c7568]">
                  {formatDuration(chapter.startTime)} - {formatDuration(chapter.endTime)}
                </span>
              </div>
              <p className="mt-2 text-sm leading-6 text-[#6c7568]">{chapter.summary}</p>
              <ul className="mt-3 space-y-2">
                {chapter.keyPoints.map((keyPoint) => (
                  <li key={keyPoint} className="flex gap-2 text-sm leading-5 text-[#394038]">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#4f6b4a]" />
                    <span>{keyPoint}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </GeneratedSection>

    </div>
  );
}

function GeneratedSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-[#dfe4dc] bg-white p-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function GeneratedFailure({ title }: { title: string }) {
  return (
    <section className="rounded-md border border-[#ead8b7] bg-[#fffaf0] p-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-2 text-sm font-medium text-[#9a5a2f]">生成失败</p>
      <p className="mt-1 text-sm leading-6 text-[#6c7568]">
        系统生成任务失败时使用这个状态，不和用户主动创建数据的「暂无数据」混用。
      </p>
    </section>
  );
}

function SubtitlesContent({
  subtitleSegments,
  source,
  currentPlaybackTime,
  onSeekToTime,
  onSelectSubtitle
}: {
  subtitleSegments: SubtitleSegment[];
  source: GenerationSource;
  currentPlaybackTime: number | null;
  onSeekToTime: (timeSeconds: number) => void;
  onSelectSubtitle: (selection: SelectedSubtitle) => void;
}) {
  const activeSubtitleIndex = findActiveSubtitleIndex(subtitleSegments, currentPlaybackTime);
  const subtitleRefs = React.useRef<Record<number, HTMLElement | null>>({});

  React.useEffect(() => {
    if (activeSubtitleIndex < 0) {
      return;
    }

    subtitleRefs.current[activeSubtitleIndex]?.scrollIntoView({
      block: "center",
      behavior: "auto"
    });
  }, [activeSubtitleIndex]);

  function handleSubtitleMouseUp(segment: SubtitleSegment) {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();

    if (!selection || !selectedText || selection.rangeCount === 0) {
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    onSelectSubtitle({
      text: selectedText,
      segment,
      x: Math.min(Math.max(rect.left + rect.width / 2 - 150, 12), window.innerWidth - 312),
      y: rect.top > 54 ? rect.top - 46 : Math.min(rect.bottom + 8, window.innerHeight - 48)
    });
  }

  return (
    <>
      <p className="text-sm leading-6 text-[#6c7568]">
        当前播放时间：{formatDuration(currentPlaybackTime)}
        <span className="ml-2 text-xs font-semibold text-[#4f6b4a]">
          字幕来源：{getGenerationSourceLabel(source)}
        </span>
      </p>
      <div className="mt-5 max-h-[58vh] space-y-3 overflow-y-auto pr-1">
        {subtitleSegments.map((segment, index) => {
          const isActive = index === activeSubtitleIndex;

          return (
          <article
            key={`${segment.startTime}-${segment.endTime}`}
            ref={(element) => {
              subtitleRefs.current[index] = element;
            }}
            className={`cursor-pointer rounded-md border p-3 transition ${
              isActive
                ? "border-[#4f6b4a] bg-[#eef5e8] shadow-sm"
                : "border-[#edf0ea] bg-[#fbfcf8] opacity-80 hover:border-[#cfd8c8] hover:opacity-100"
            }`}
            onMouseUp={() => handleSubtitleMouseUp(segment)}
            onClick={() => {
              const selectedText = window.getSelection()?.toString().trim();

              if (selectedText) {
                return;
              }

              onSeekToTime(segment.startTime);
            }}
          >
            <p className="text-xs font-medium text-[#6c7568]">
              {formatDuration(segment.startTime)} - {formatDuration(segment.endTime)}
            </p>
            <p className={`mt-2 text-base font-semibold leading-6 ${isActive ? "text-[#1f351d]" : "text-[#20241f]"}`}>
              {segment.englishText}
            </p>
            <p className="mt-2 text-sm leading-6 text-[#4f5a4c]">{segment.chineseText}</p>
          </article>
          );
        })}
      </div>
    </>
  );
}

function SelectionActionMenu({
  selectedSubtitle,
  onAskAi,
  onCreateNote,
  onAddVocabulary,
  onCopy,
  onClose
}: {
  selectedSubtitle: SelectedSubtitle;
  onAskAi: () => void;
  onCreateNote: () => void;
  onAddVocabulary: () => void;
  onCopy: () => void;
  onClose: () => void;
}) {
  const menuRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    function closeAndClearSelection() {
      window.getSelection()?.removeAllRanges();
      onClose();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeAndClearSelection();
      }
    }

    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        closeAndClearSelection();
      }
    }

    function handleScroll() {
      closeAndClearSelection();
    }

    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("scroll", handleScroll, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 rounded-full border border-[#dfe4dc] bg-white/95 p-1 shadow-lg backdrop-blur"
      style={{ left: selectedSubtitle.x, top: selectedSubtitle.y }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="flex items-center gap-1">
        <ActionMenuButton label="问 AI" onClick={onAskAi} />
        <ActionMenuButton label="笔记" onClick={onCreateNote} />
        <ActionMenuButton label="生词" onClick={onAddVocabulary} />
        <ActionMenuButton label="复制" onClick={onCopy} />
      </div>
    </div>
  );
}

function ActionMenuButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="rounded-full px-3 py-1.5 text-xs font-semibold text-[#20241f] transition hover:bg-[#eef5e8]"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function ChatContent({
  chatDraft,
  chatItems,
  onChatDraftChange,
  onSendChatDraft
}: {
  chatDraft: string;
  chatItems: MockChatItem[];
  onChatDraftChange: (draft: string) => void;
  onSendChatDraft: () => void | Promise<void>;
}) {
  const isGenerating = chatItems.some((item) => item.source === "loading");

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-[#dfe4dc] bg-white p-3">
        <label className="text-xs font-semibold text-[#6c7568]" htmlFor="chat-draft">
          输入问题
        </label>
        <textarea
          id="chat-draft"
          className="mt-2 min-h-28 w-full resize-none rounded-md border border-[#dfe4dc] bg-[#fbfcf8] p-3 text-sm leading-6 outline-none focus:border-[#4f6b4a]"
          placeholder="选中字幕后点击“问 AI”，这里会预填问题。"
          value={chatDraft}
          onChange={(event) => onChatDraftChange(event.target.value)}
        />
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            className="rounded-md bg-[#20241f] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#c4cabc]"
            disabled={!chatDraft.trim() || isGenerating}
            onClick={onSendChatDraft}
          >
            {isGenerating ? "生成中" : "发送"}
          </button>
        </div>
      </div>

      {chatItems.length === 0 ? (
        <EmptyState title="暂无数据" description="你还没有发送过问题。" />
      ) : (
        <div className="space-y-4">
        {chatItems.map((item) => (
          <article key={item.id} className="space-y-3">
            <div className="rounded-md border border-[#dfe4dc] bg-[#fbfcf8] p-3">
              <p className="text-xs font-semibold text-[#6c7568]">我的问题</p>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[#20241f]">{item.question}</p>
            </div>
            <div className="rounded-md border border-[#dfe4dc] bg-white p-3">
              <p className={`text-xs font-semibold ${getChatSourceClassName(item.source)}`}>
                {getChatSourceLabel(item.source)}
              </p>
              {item.source === "loading" ? (
                <AiLoadingBlock description="正在结合视频摘要和字幕上下文生成回复。" />
              ) : (
                <p className="mt-2 text-sm leading-6 text-[#394038]">{item.answer}</p>
              )}
            </div>
          </article>
        ))}
        </div>
      )}
    </div>
  );
}

function NotesContent({
  noteItems,
  onUpdateNoteComment,
  onOrganizeNote,
  onCancelNote,
  onSaveNote
}: {
  noteItems: MockNoteItem[];
  onUpdateNoteComment: (noteId: string, userComment: string) => void;
  onOrganizeNote: (noteId: string) => void;
  onCancelNote: (noteId: string) => void;
  onSaveNote: (noteId: string) => void;
}) {
  if (noteItems.length === 0) {
    return <EmptyState title="暂无数据" description="你还没有在当前视频下记录笔记。" />;
  }

  return (
    <div className="space-y-3">
        {noteItems.map((item) => (
          <article key={item.id} className="rounded-md border border-[#dfe4dc] bg-[#fbfcf8] p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold text-[#4f6b4a]">
                {item.isSaved ? "已保存笔记" : "未保存编辑块"}
              </p>
              <span className="text-xs font-medium text-[#6c7568]">
                {formatDuration(item.startTime)} - {formatDuration(item.endTime)}
              </span>
            </div>
            <p className="mt-3 text-sm font-semibold leading-6 text-[#20241f]">{item.sourceText}</p>
            <p className="mt-2 text-sm leading-6 text-[#4f5a4c]">{item.sourceTranslation}</p>

            {item.aiOrganizing ? (
              <div className="mt-4 rounded-md border border-[#dfe4dc] bg-white p-3">
                <p className="text-xs font-semibold text-[#4f6b4a]">AI 整理中</p>
                <AiLoadingBlock description="正在把选中的字幕整理成可沉淀的中文笔记。" />
              </div>
            ) : null}

            {item.aiOrganizeFailed ? (
              <div className="mt-4">
                <GeneratedFailure title="笔记整理失败" />
              </div>
            ) : null}

            {item.aiOrganizedText && !item.aiOrganizing ? (
              <div className="mt-4 rounded-md border border-[#dfe4dc] bg-white p-3">
                <p className="text-xs font-semibold text-[#4f6b4a]">AI 整理结果</p>
                <p className="mt-2 text-sm leading-6 text-[#394038]">{item.aiOrganizedText}</p>
                {!item.isSaved ? (
                  <button
                    type="button"
                    className="mt-3 rounded-md border border-[#dfe4dc] px-3 py-1.5 text-xs font-semibold hover:border-[#4f6b4a] hover:bg-[#eef5e8]"
                    onClick={() => onOrganizeNote(item.id)}
                  >
                    重新生成
                  </button>
                ) : null}
              </div>
            ) : !item.isSaved ? (
              <button
                type="button"
                className="mt-4 rounded-md border border-[#dfe4dc] bg-white px-3 py-2 text-sm font-semibold hover:border-[#4f6b4a] hover:bg-[#eef5e8] disabled:cursor-not-allowed disabled:bg-[#f1f3ee] disabled:text-[#9aa392]"
                disabled={item.aiOrganizing}
                onClick={() => onOrganizeNote(item.id)}
              >
                {item.aiOrganizing ? "整理中" : "用 AI 重新整理"}
              </button>
            ) : null}

            <label className="mt-4 block text-xs font-semibold text-[#6c7568]" htmlFor={item.id}>
              我的想法
            </label>
            <textarea
              id={item.id}
              className="mt-2 min-h-24 w-full resize-none rounded-md border border-[#dfe4dc] bg-white p-3 text-sm outline-none focus:border-[#4f6b4a] disabled:bg-[#f1f3ee]"
              placeholder="写下你对这段字幕的想法。"
              value={item.userComment}
              disabled={item.isSaved}
              onChange={(event) => onUpdateNoteComment(item.id, event.target.value)}
            />

            {!item.isSaved ? (
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded-md border border-[#dfe4dc] px-3 py-2 text-sm font-semibold hover:bg-white"
                  onClick={() => onCancelNote(item.id)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="rounded-md bg-[#20241f] px-3 py-2 text-sm font-semibold text-white"
                  onClick={() => onSaveNote(item.id)}
                >
                  保存笔记
                </button>
              </div>
            ) : null}
          </article>
        ))}
    </div>
  );
}

function VocabularyContent({
  vocabularyItems,
  hasGenerationFailed,
  isGenerating,
  onGenerateMoreExamples
}: {
  vocabularyItems: MockVocabularyItem[];
  hasGenerationFailed: boolean;
  isGenerating: boolean;
  onGenerateMoreExamples: (vocabularyItemId: string) => void;
}) {
  if (isGenerating && vocabularyItems.length === 0) {
    return (
      <AiGeneratingCard
        title="正在生成生词"
        description="正在从选中的字幕里提取单词和短语，并生成释义与例句。"
      />
    );
  }

  if (hasGenerationFailed && vocabularyItems.length === 0) {
    return <GeneratedFailure title="生词生成失败" />;
  }

  if (vocabularyItems.length === 0) {
    return <EmptyState title="暂无数据" description="你还没有在当前视频下加入生词或短语。" />;
  }

  return (
    <div className="space-y-3">
        {isGenerating ? (
          <AiGeneratingCard
            title="正在生成生词"
            description="正在从选中的字幕里提取单词和短语，并生成释义与例句。"
          />
        ) : null}
        {hasGenerationFailed ? <GeneratedFailure title="生词生成失败" /> : null}
        {vocabularyItems.map((item) => (
          <article key={item.id} className="rounded-md border border-[#dfe4dc] bg-[#fbfcf8] p-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-base font-semibold">{item.text}</h3>
              <span className="rounded-full bg-[#eef5e8] px-2 py-1 text-xs font-semibold text-[#4f6b4a]">
                {item.type}
              </span>
            </div>
            <p className="mt-2 text-sm font-medium text-[#394038]">{item.meaningZh}</p>
            <div className="mt-3 rounded-md border border-[#edf0ea] bg-white p-3">
              <p className="text-xs font-semibold text-[#6c7568]">来源字幕</p>
              <p className="mt-2 text-sm leading-6 text-[#20241f]">{item.sourceSentence}</p>
              <p className="mt-1 text-sm leading-6 text-[#6c7568]">{item.sourceTranslation}</p>
            </div>

            {(item.generatedExamples?.length ?? 0) > 0 ? (
              <div className="mt-3 rounded-md border border-[#edf0ea] bg-white p-3">
                <p className="text-xs font-semibold text-[#6c7568]">AI 例句</p>
                <div className="mt-3 space-y-3">
                  {item.generatedExamples?.map((example, index) => (
                    <div key={`${example.en}-${index}`} className="border-t border-[#edf0ea] pt-3 first:border-t-0 first:pt-0">
                      <p className="text-sm leading-6 text-[#20241f]">{example.en}</p>
                      <p className="mt-1 text-sm leading-6 text-[#6c7568]">{example.zh}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {item.examplesGenerationFailed ? (
              <div className="mt-3">
                <GeneratedFailure title="例句生成失败" />
              </div>
            ) : null}

            {item.examplesGenerating ? (
              <AiGeneratingCard title="正在生成例句" description="正在生成不重复来源字幕的新例句。" />
            ) : (
              <button
                type="button"
                className="mt-3 rounded-md border border-[#dfe4dc] bg-white px-3 py-2 text-sm font-semibold hover:border-[#4f6b4a] hover:bg-[#eef5e8]"
                onClick={() => onGenerateMoreExamples(item.id)}
              >
                生成更多例句
              </button>
            )}
          </article>
        ))}
    </div>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="mt-5 rounded-md border border-dashed border-[#ccd4c7] bg-[#fbfcf8] p-5 text-center">
      <div className="mx-auto grid h-16 w-20 grid-cols-3 gap-1">
        {Array.from({ length: 9 }).map((_, index) => (
          <span key={index} className="rounded-sm bg-[#e5eadf]" />
        ))}
      </div>
      <h2 className="mt-4 text-base font-semibold">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-[#6c7568]">{description}</p>
    </div>
  );
}

function AiGeneratingCard({ title, description }: { title: string; description: string }) {
  return (
    <section className="rounded-md border border-[#dfe4dc] bg-white p-3">
      <p className="text-xs font-semibold text-[#4f6b4a]">{title}</p>
      <AiLoadingBlock description={description} />
    </section>
  );
}

function AiLoadingBlock({ description }: { description: string }) {
  return (
    <div className="mt-3 space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-[#6c7568]">
        <span className="h-2 w-2 animate-pulse rounded-full bg-[#4f6b4a]" />
        <span>{description}</span>
      </div>
      <div className="space-y-2">
        <span className="block h-3 w-11/12 animate-pulse rounded bg-[#e5eadf]" />
        <span className="block h-3 w-8/12 animate-pulse rounded bg-[#e5eadf]" />
      </div>
    </div>
  );
}

function VideoSummary({ videoInfo }: { videoInfo: VideoInfo }) {
  return (
    <div className="mt-5">
      <div className="flex gap-3">
        {videoInfo.thumbnailUrl ? (
          <img
            src={videoInfo.thumbnailUrl}
            alt=""
            className="h-16 w-24 shrink-0 rounded-md object-cover"
          />
        ) : null}
        <div className="min-w-0">
          <p className="text-xs font-medium text-[#6c7568]">已识别 YouTube 视频</p>
          <h2 className="mt-1 line-clamp-3 text-base font-semibold leading-6">{videoInfo.title || "标题读取中"}</h2>
        </div>
      </div>

      <dl className="mt-5 space-y-3 text-sm">
        <InfoRow label="videoId" value={videoInfo.videoId || "读取中"} />
        <InfoRow label="时长" value={formatDuration(videoInfo.durationSeconds)} />
        <InfoRow label="频道" value={videoInfo.channelName || "读取中"} />
        <InfoRow label="URL" value={videoInfo.url} />
      </dl>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[4.5rem_1fr] gap-2">
      <dt className="text-[#6c7568]">{label}</dt>
      <dd className="break-words font-medium text-[#20241f]">{value}</dd>
    </div>
  );
}

export default App;

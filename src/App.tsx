import * as React from "react";
import { mockOverview, mockSubtitleSegments } from "./mock/learning-data";
import { loadCloudLearningState, saveCloudLearningState } from "./services/cloud-learning-store";
import {
  isSupabaseConfigured,
  supabase,
  type SupabaseUser
} from "./services/supabase";

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

type PlaybackTimePayload = {
  videoId: string;
  currentTime: number;
  collectedAt: number;
};

type SubtitleSegment = (typeof mockSubtitleSegments)[number];

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
};

type MockVocabularyItem = {
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

type StoredLearningState = {
  parsed: true;
  chatItems: MockChatItem[];
  noteItems: MockNoteItem[];
  vocabularyItems: MockVocabularyItem[];
  updatedAt: number;
};

const VIDEO_INFO_REQUEST = "VIDEO_INSIGHT_GET_VIDEO_INFO";
const VIDEO_INFO_UPDATED = "VIDEO_INSIGHT_VIDEO_INFO_UPDATED";
const PLAYBACK_TIME_UPDATED = "VIDEO_INSIGHT_PLAYBACK_TIME_UPDATED";
const SEEK_TO_TIME = "VIDEO_INSIGHT_SEEK_TO_TIME";
const STORAGE_KEY_PREFIX = "video-insight:learning:";

const MOCK_PARSE_STEPS: ParseStep[] = [
  { key: "fetch_captions", label: "获取英文字幕" },
  { key: "segment_subtitles", label: "重切分字幕" },
  { key: "translate_subtitles", label: "翻译中文字幕" },
  { key: "generate_summary", label: "生成整体摘要" },
  { key: "generate_chapters_timeline", label: "生成章节与时间轴" },
  { key: "generate_mindmap", label: "生成 Mermaid 思维导图" },
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

function createCompletedParseStepStatuses() {
  return MOCK_PARSE_STEPS.reduce<Record<string, ParseStepStatus>>((statuses, step) => {
    statuses[step.key] = "completed";
    return statuses;
  }, {});
}

function getLearningStorageKey(videoId: string) {
  return `${STORAGE_KEY_PREFIX}${videoId}`;
}

function normalizeStoredLearningState(value: unknown): StoredLearningState | null {
  const maybeState = value as Partial<StoredLearningState> | undefined;

  if (!maybeState?.parsed) {
    return null;
  }

  return {
    parsed: true,
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

function formatDuration(durationSeconds: number | null) {
  if (durationSeconds === null) {
    return "读取中";
  }

  const hours = Math.floor(durationSeconds / 3600);
  const minutes = Math.floor((durationSeconds % 3600) / 60);
  const seconds = durationSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
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

function App() {
  const [panelState, setPanelState] = React.useState<PanelState>({ status: "identifying" });
  const [parseStepStatuses, setParseStepStatuses] = React.useState(createInitialParseStepStatuses);
  const [activeLearningTab, setActiveLearningTab] = React.useState<LearningTabKey>("overview");
  const [currentPlaybackTime, setCurrentPlaybackTime] = React.useState<number | null>(null);
  const [selectedSubtitle, setSelectedSubtitle] = React.useState<SelectedSubtitle | null>(null);
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

    if (suppressNextStorageSaveRef.current) {
      suppressNextStorageSaveRef.current = false;
      return;
    }

    void saveStoredLearningState(learningVideoId, {
      parsed: true,
      chatItems: mockChatItems,
      noteItems: mockNoteItems,
      vocabularyItems: mockVocabularyItems,
      updatedAt: Date.now()
    });
  }, [learningVideoId, mockChatItems, mockNoteItems, mockVocabularyItems]);

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

    const timeoutId = window.setTimeout(() => {
      setCloudSyncStatus("syncing");
      setCloudSyncMessage("正在同步到 Supabase。");

      saveCloudLearningState(authUser.id, learningVideoInfo, {
        chatItems: mockChatItems,
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
  }, [authUser, learningVideoId, mockChatItems, mockNoteItems, mockVocabularyItems]);

  React.useEffect(() => {
    let disposed = false;

    function clearParseTimers() {
      parseTimeoutIdsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
      parseTimeoutIdsRef.current = [];
    }

    function resetLearningDataForCurrentVideo() {
      setActiveLearningTab("overview");
      setSelectedSubtitle(null);
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
          setMockChatItems(storedLearningState.chatItems);
          setMockNoteItems(storedLearningState.noteItems);
          setMockVocabularyItems(storedLearningState.vocabularyItems);
          setActiveLearningTab("overview");
          setPanelState({ status: "learning", videoInfo });
          return;
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

  function handleStartParsing(videoInfo: VideoInfo) {
    if (!videoInfo.videoId) {
      return;
    }

    parseTimeoutIdsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    parseTimeoutIdsRef.current = [];
    learnedVideoIdRef.current = null;
    parsingVideoIdRef.current = videoInfo.videoId;
    setParseStepStatuses(createInitialParseStepStatuses());
    setPanelState({ status: "parsing", videoInfo });

    MOCK_PARSE_STEPS.forEach((step, index) => {
      const processingTimeoutId = window.setTimeout(() => {
        if (parsingVideoIdRef.current !== videoInfo.videoId) {
          return;
        }

        setParseStepStatuses((currentStatuses) => ({
          ...currentStatuses,
          [step.key]: "processing"
        }));
      }, index * 900);

      const completedTimeoutId = window.setTimeout(() => {
        if (parsingVideoIdRef.current !== videoInfo.videoId) {
          return;
        }

        setParseStepStatuses((currentStatuses) => ({
          ...currentStatuses,
          [step.key]: "completed"
        }));

        if (index === MOCK_PARSE_STEPS.length - 1) {
          parsingVideoIdRef.current = null;
          learnedVideoIdRef.current = videoInfo.videoId;
          setActiveLearningTab("overview");
          setPanelState({ status: "learning", videoInfo });
        }
      }, index * 900 + 650);

      parseTimeoutIdsRef.current.push(processingTimeoutId, completedTimeoutId);
    });
  }

  async function handleSeekToTime(timeSeconds: number) {
    const activeTab = await getActiveTab();

    if (!activeTab?.id) {
      return;
    }

    await seekActiveTabToTime(activeTab.id, timeSeconds);
    setCurrentPlaybackTime(timeSeconds);
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

  function handleSendChatDraft() {
    const trimmedDraft = chatDraft.trim();

    if (!trimmedDraft) {
      return;
    }

    setMockChatItems((items) => [createMockChatItem(trimmedDraft), ...items]);
    setChatDraft("");
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

  function handleAddVocabularyFromSubtitle() {
    if (!selectedSubtitle) {
      return;
    }

    setMockVocabularyItems((items) => [
      ...createMockVocabularyItems(selectedSubtitle.segment, selectedSubtitle.text),
      ...items
    ]);
    setActiveLearningTab("vocabulary");
    clearSelectedSubtitle();
  }

  function handleUpdateNoteComment(noteId: string, userComment: string) {
    setMockNoteItems((items) =>
      items.map((item) => (item.id === noteId ? { ...item, userComment } : item))
    );
  }

  function handleOrganizeNote(noteId: string) {
    setMockNoteItems((items) =>
      items.map((item) =>
        item.id === noteId
          ? { ...item, aiOrganizedText: createMockOrganizedNote(item.sourceText) }
          : item
      )
    );
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
          activeLearningTab={activeLearningTab}
          currentPlaybackTime={currentPlaybackTime}
          selectedSubtitle={selectedSubtitle}
          chatDraft={chatDraft}
          mockChatItems={mockChatItems}
          mockNoteItems={mockNoteItems}
          mockVocabularyItems={mockVocabularyItems}
          onSelectLearningTab={setActiveLearningTab}
          onChatDraftChange={setChatDraft}
          onSendChatDraft={handleSendChatDraft}
          onStartParsing={handleStartParsing}
          onSeekToTime={handleSeekToTime}
          onSelectSubtitle={setSelectedSubtitle}
          onClearSelectedSubtitle={clearSelectedSubtitle}
          onAskAiFromSubtitle={handleAskAiFromSubtitle}
          onCreateNoteFromSubtitle={handleCreateNoteFromSubtitle}
          onAddVocabularyFromSubtitle={handleAddVocabularyFromSubtitle}
          onCopySelectedSubtitle={handleCopySelectedSubtitle}
          onUpdateNoteComment={handleUpdateNoteComment}
          onOrganizeNote={handleOrganizeNote}
          onCancelNote={handleCancelNote}
          onSaveNote={handleSaveNote}
        />

        <p className="mt-auto text-sm leading-6 text-[#6c7568]">
          Phase 9 使用 Supabase Auth 和数据库同步学习状态。真实 AI 和真实字幕会在后续阶段加入。
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
  activeLearningTab,
  currentPlaybackTime,
  selectedSubtitle,
  chatDraft,
  mockChatItems,
  mockNoteItems,
  mockVocabularyItems,
  onSelectLearningTab,
  onChatDraftChange,
  onSendChatDraft,
  onStartParsing,
  onSeekToTime,
  onSelectSubtitle,
  onClearSelectedSubtitle,
  onAskAiFromSubtitle,
  onCreateNoteFromSubtitle,
  onAddVocabularyFromSubtitle,
  onCopySelectedSubtitle,
  onUpdateNoteComment,
  onOrganizeNote,
  onCancelNote,
  onSaveNote
}: {
  panelState: PanelState;
  parseStepStatuses: Record<string, ParseStepStatus>;
  activeLearningTab: LearningTabKey;
  currentPlaybackTime: number | null;
  selectedSubtitle: SelectedSubtitle | null;
  mockChatItems: MockChatItem[];
  mockNoteItems: MockNoteItem[];
  mockVocabularyItems: MockVocabularyItem[];
  chatDraft: string;
  onSelectLearningTab: (tabKey: LearningTabKey) => void;
  onChatDraftChange: (draft: string) => void;
  onSendChatDraft: () => void;
  onStartParsing: (videoInfo: VideoInfo) => void;
  onSeekToTime: (timeSeconds: number) => void;
  onSelectSubtitle: (selection: SelectedSubtitle) => void;
  onClearSelectedSubtitle: () => void;
  onAskAiFromSubtitle: () => void;
  onCreateNoteFromSubtitle: () => void;
  onAddVocabularyFromSubtitle: () => void;
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
    return (
      <StatusCard
        title={panelState.reason}
        description={panelState.detail}
        tone="warning"
      />
    );
  }

  if (panelState.status === "parsing") {
    return <ParsingCard videoInfo={panelState.videoInfo} parseStepStatuses={parseStepStatuses} />;
  }

  if (panelState.status === "learning") {
    return (
      <LearningView
        videoInfo={panelState.videoInfo}
        activeLearningTab={activeLearningTab}
        currentPlaybackTime={currentPlaybackTime}
        selectedSubtitle={selectedSubtitle}
        chatDraft={chatDraft}
        mockChatItems={mockChatItems}
        mockNoteItems={mockNoteItems}
        mockVocabularyItems={mockVocabularyItems}
        onSelectLearningTab={onSelectLearningTab}
        onChatDraftChange={onChatDraftChange}
        onSendChatDraft={onSendChatDraft}
        onSeekToTime={onSeekToTime}
        onSelectSubtitle={onSelectSubtitle}
        onClearSelectedSubtitle={onClearSelectedSubtitle}
        onAskAiFromSubtitle={onAskAiFromSubtitle}
        onCreateNoteFromSubtitle={onCreateNoteFromSubtitle}
        onAddVocabularyFromSubtitle={onAddVocabularyFromSubtitle}
        onCopySelectedSubtitle={onCopySelectedSubtitle}
        onUpdateNoteComment={onUpdateNoteComment}
        onOrganizeNote={onOrganizeNote}
        onCancelNote={onCancelNote}
        onSaveNote={onSaveNote}
      />
    );
  }

  return <ReadyToParseCard videoInfo={panelState.videoInfo} onStartParsing={onStartParsing} />;
}

function StatusCard({
  title,
  description,
  tone = "neutral"
}: {
  title: string;
  description: string;
  tone?: "neutral" | "warning";
}) {
  const toneClassName =
    tone === "warning" ? "border-[#ead8b7] bg-[#fffaf0]" : "border-[#dfe4dc] bg-white/70";

  return (
    <section className={`rounded-lg border p-4 shadow-sm ${toneClassName}`}>
      <p className="text-base font-semibold">{title}</p>
      <p className="mt-2 text-sm leading-6 text-[#6c7568]">{description}</p>
    </section>
  );
}

function ReadyToParseCard({
  videoInfo,
  onStartParsing
}: {
  videoInfo: VideoInfo;
  onStartParsing: (videoInfo: VideoInfo) => void;
}) {
  return (
    <section className="rounded-lg border border-[#dfe4dc] bg-white/70 p-4 shadow-sm">
      <p className="text-sm font-semibold text-[#4f6b4a]">当前视频可解析</p>
      <p className="mt-2 text-sm leading-6 text-[#6c7568]">
        已读取视频基础信息。点击下方按钮后，会展示 mock 解析进度。
      </p>
      <VideoSummary videoInfo={videoInfo} />
      <button
        type="button"
        className="mt-5 w-full rounded-md bg-[#20241f] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#343a31]"
        onClick={() => onStartParsing(videoInfo)}
      >
        解析当前视频
      </button>
    </section>
  );
}

function ParsingCard({
  videoInfo,
  parseStepStatuses
}: {
  videoInfo: VideoInfo;
  parseStepStatuses: Record<string, ParseStepStatus>;
}) {
  const completedCount = MOCK_PARSE_STEPS.filter(
    (step) => parseStepStatuses[step.key] === "completed"
  ).length;
  const progressPercent = Math.round((completedCount / MOCK_PARSE_STEPS.length) * 100);

  return (
    <section className="rounded-lg border border-[#dfe4dc] bg-white/70 p-4 shadow-sm">
      <p className="text-sm font-semibold text-[#4f6b4a]">解析中</p>
      <p className="mt-2 text-sm leading-6 text-[#6c7568]">
        正在按 PRD 的解析步骤模拟处理，当前不调用 AI、不保存数据库、不获取真实字幕。
      </p>
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
  chatDraft,
  mockChatItems,
  mockNoteItems,
  mockVocabularyItems,
  onSelectLearningTab,
  onChatDraftChange,
  onSendChatDraft,
  onSeekToTime,
  onSelectSubtitle,
  onClearSelectedSubtitle,
  onAskAiFromSubtitle,
  onCreateNoteFromSubtitle,
  onAddVocabularyFromSubtitle,
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
  chatDraft: string;
  mockChatItems: MockChatItem[];
  mockNoteItems: MockNoteItem[];
  mockVocabularyItems: MockVocabularyItem[];
  onSelectLearningTab: (tabKey: LearningTabKey) => void;
  onChatDraftChange: (draft: string) => void;
  onSendChatDraft: () => void;
  onSeekToTime: (timeSeconds: number) => void;
  onSelectSubtitle: (selection: SelectedSubtitle) => void;
  onClearSelectedSubtitle: () => void;
  onAskAiFromSubtitle: () => void;
  onCreateNoteFromSubtitle: () => void;
  onAddVocabularyFromSubtitle: () => void;
  onCopySelectedSubtitle: () => void;
  onUpdateNoteComment: (noteId: string, userComment: string) => void;
  onOrganizeNote: (noteId: string) => void;
  onCancelNote: (noteId: string) => void;
  onSaveNote: (noteId: string) => void;
}) {
  return (
    <div className="space-y-4">
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
          chatDraft={chatDraft}
          mockChatItems={mockChatItems}
          mockNoteItems={mockNoteItems}
          mockVocabularyItems={mockVocabularyItems}
          onChatDraftChange={onChatDraftChange}
          onSendChatDraft={onSendChatDraft}
          onSeekToTime={onSeekToTime}
          onSelectSubtitle={onSelectSubtitle}
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
  chatDraft,
  mockChatItems,
  mockNoteItems,
  mockVocabularyItems,
  onChatDraftChange,
  onSendChatDraft,
  onSeekToTime,
  onSelectSubtitle,
  onUpdateNoteComment,
  onOrganizeNote,
  onCancelNote,
  onSaveNote
}: {
  activeLearningTab: LearningTabKey;
  videoInfo: VideoInfo;
  currentPlaybackTime: number | null;
  chatDraft: string;
  mockChatItems: MockChatItem[];
  mockNoteItems: MockNoteItem[];
  mockVocabularyItems: MockVocabularyItem[];
  onChatDraftChange: (draft: string) => void;
  onSendChatDraft: () => void;
  onSeekToTime: (timeSeconds: number) => void;
  onSelectSubtitle: (selection: SelectedSubtitle) => void;
  onUpdateNoteComment: (noteId: string, userComment: string) => void;
  onOrganizeNote: (noteId: string) => void;
  onCancelNote: (noteId: string) => void;
  onSaveNote: (noteId: string) => void;
}) {
  if (activeLearningTab === "overview") {
    return (
      <>
        <VideoSummary videoInfo={videoInfo} />
        <OverviewContent />
      </>
    );
  }

  if (activeLearningTab === "subtitles") {
    return (
      <SubtitlesContent
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

  return <VocabularyContent vocabularyItems={mockVocabularyItems} />;
}

function OverviewContent() {
  return (
    <div className="mt-5 space-y-4">
      <GeneratedSection title="视频摘要">
        <p className="text-sm leading-6 text-[#394038]">{mockOverview.summary}</p>
      </GeneratedSection>

      <GeneratedSection title="章节划分">
        <div className="space-y-3">
          {mockOverview.chapters.map((chapter, index) => (
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

      <GeneratedSection title="Mermaid 思维导图">
        <pre className="overflow-auto rounded-md bg-[#20241f] p-3 text-xs leading-5 text-[#f7f8f5]">
          <code>{mockOverview.mindmapMermaid}</code>
        </pre>
      </GeneratedSection>

      <GeneratedFailure title="生成失败状态示例" />
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
  currentPlaybackTime,
  onSeekToTime,
  onSelectSubtitle
}: {
  currentPlaybackTime: number | null;
  onSeekToTime: (timeSeconds: number) => void;
  onSelectSubtitle: (selection: SelectedSubtitle) => void;
}) {
  const activeSubtitleIndex = mockSubtitleSegments.findIndex(
    (segment) =>
      currentPlaybackTime !== null &&
      currentPlaybackTime >= segment.startTime &&
      currentPlaybackTime < segment.endTime
  );
  const subtitleRefs = React.useRef<Record<number, HTMLElement | null>>({});

  React.useEffect(() => {
    if (activeSubtitleIndex < 0) {
      return;
    }

    subtitleRefs.current[activeSubtitleIndex]?.scrollIntoView({
      block: "center",
      behavior: "smooth"
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
        当前播放时间：{currentPlaybackTime === null ? "读取中" : formatDuration(Math.floor(currentPlaybackTime))}
      </p>
      <div className="mt-5 max-h-[58vh] space-y-3 overflow-y-auto pr-1">
        {mockSubtitleSegments.map((segment, index) => {
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
  onSendChatDraft: () => void;
}) {
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
            disabled={!chatDraft.trim()}
            onClick={onSendChatDraft}
          >
            发送
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
              <p className="text-xs font-semibold text-[#4f6b4a]">Mock AI 回复</p>
              <p className="mt-2 text-sm leading-6 text-[#394038]">{item.answer}</p>
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

            {item.aiOrganizedText ? (
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
                className="mt-4 rounded-md border border-[#dfe4dc] bg-white px-3 py-2 text-sm font-semibold hover:border-[#4f6b4a] hover:bg-[#eef5e8]"
                onClick={() => onOrganizeNote(item.id)}
              >
                用 AI 重新整理
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

function VocabularyContent({ vocabularyItems }: { vocabularyItems: MockVocabularyItem[] }) {
  if (vocabularyItems.length === 0) {
    return <EmptyState title="暂无数据" description="你还没有在当前视频下加入生词或短语。" />;
  }

  return (
    <div className="space-y-3">
        {vocabularyItems.map((item) => (
          <article key={item.id} className="rounded-md border border-[#dfe4dc] bg-[#fbfcf8] p-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-base font-semibold">{item.text}</h3>
              <span className="rounded-full bg-[#eef5e8] px-2 py-1 text-xs font-semibold text-[#4f6b4a]">
                {item.type}
              </span>
            </div>
            <p className="mt-2 text-sm font-medium text-[#394038]">{item.meaningZh}</p>
            <p className="mt-3 text-sm leading-6 text-[#20241f]">{item.sourceSentence}</p>
            <p className="mt-1 text-sm leading-6 text-[#6c7568]">{item.sourceTranslation}</p>
            <div className="mt-3 rounded-md bg-white p-3">
              <p className="text-xs font-semibold text-[#6c7568]">例句</p>
              <p className="mt-2 text-sm leading-6 text-[#20241f]">{item.example.en}</p>
              <p className="mt-1 text-sm leading-6 text-[#6c7568]">{item.example.zh}</p>
            </div>
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

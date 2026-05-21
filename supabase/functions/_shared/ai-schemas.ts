export type RawSubtitleSegment = {
  startTime: number;
  endTime: number;
  text: string;
};

export type GeneratedSubtitleSegment = {
  startTime: number;
  endTime: number;
  englishText: string;
  chineseText: string;
  keywords: string[];
};

export type SubtitleTranslation = {
  index: number;
  chineseText: string;
  keywords: string[];
};

export type GeneratedOverview = {
  summary: string;
  chapters: Array<{
    title: string;
    startTime: number;
    endTime: number;
    summary: string;
    keyPoints: string[];
  }>;
  timeline: Array<{
    timeSeconds: number;
    title: string;
    description: string;
  }>;
  mindmapMermaid: string;
};

export type OverviewChunk = {
  chunkIndex: number;
  startTime: number;
  endTime: number;
  summary: string;
  keyPoints: string[];
};

export type VocabularyExample = {
  en: string;
  zh: string;
};

export type VocabularyItem = {
  normalizedText: string;
  meaningZh: string;
};

export type GenerateVocabularyItemInput = {
  selectedText: string;
  sourceSentence: string;
  sourceTranslation: string;
  videoContext: string;
};

export type AnswerQuestionInput = {
  question: string;
  videoTitle: string;
  overviewSummary: string;
  subtitles: GeneratedSubtitleSegment[];
  recentChat: Array<{
    question: string;
    answer: string;
  }>;
};

export class InvalidModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidModelOutputError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidModelOutputError(`Invalid string field: ${fieldName}`);
  }

  return value;
}

function assertNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidModelOutputError(`Invalid number field: ${fieldName}`);
  }

  return value;
}

function assertStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new InvalidModelOutputError(`Invalid string array field: ${fieldName}`);
  }

  return value.map((item, index) => assertString(item, `${fieldName}[${index}]`));
}

function assertRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new InvalidModelOutputError(`Invalid object field: ${fieldName}`);
  }

  return value;
}

export function validateSubtitleSegments(value: unknown): GeneratedSubtitleSegment[] {
  const root = assertRecord(value, "root");
  const segments = root.segments;

  if (!Array.isArray(segments) || segments.length === 0) {
    throw new InvalidModelOutputError("segments must be a non-empty array");
  }

  return segments.map((segment, index) => {
    const item = assertRecord(segment, `segments[${index}]`);

    return {
      startTime: assertNumber(item.startTime, `segments[${index}].startTime`),
      endTime: assertNumber(item.endTime, `segments[${index}].endTime`),
      englishText: assertString(item.englishText, `segments[${index}].englishText`),
      chineseText: assertString(item.chineseText, `segments[${index}].chineseText`),
      keywords: Array.isArray(item.keywords)
        ? assertStringArray(item.keywords, `segments[${index}].keywords`)
        : []
    };
  });
}

export function validateSubtitleTranslations(value: unknown): SubtitleTranslation[] {
  const root = assertRecord(value, "root");
  const translations = root.translations;

  if (!Array.isArray(translations) || translations.length === 0) {
    throw new InvalidModelOutputError("translations must be a non-empty array");
  }

  return translations.map((translation, index) => {
    const item = assertRecord(translation, `translations[${index}]`);

    return {
      index: assertNumber(item.index, `translations[${index}].index`),
      chineseText: assertString(item.chineseText, `translations[${index}].chineseText`),
      keywords: Array.isArray(item.keywords)
        ? assertStringArray(item.keywords, `translations[${index}].keywords`)
        : []
    };
  });
}

export function validateOverview(value: unknown): GeneratedOverview {
  const root = assertRecord(value, "root");
  const overview = assertRecord(root.overview, "overview");

  const chapters = overview.chapters;
  const timeline = overview.timeline;

  if (!Array.isArray(chapters) || chapters.length === 0) {
    throw new InvalidModelOutputError("overview.chapters must be a non-empty array");
  }

  if (!Array.isArray(timeline)) {
    throw new InvalidModelOutputError("overview.timeline must be an array");
  }

  return {
    summary: assertString(overview.summary, "overview.summary"),
    chapters: chapters.map((chapter, index) => {
      const item = assertRecord(chapter, `overview.chapters[${index}]`);

      return {
        title: assertString(item.title, `overview.chapters[${index}].title`),
        startTime: assertNumber(item.startTime, `overview.chapters[${index}].startTime`),
        endTime: assertNumber(item.endTime, `overview.chapters[${index}].endTime`),
        summary: assertString(item.summary, `overview.chapters[${index}].summary`),
        keyPoints: assertStringArray(item.keyPoints, `overview.chapters[${index}].keyPoints`)
      };
    }),
    timeline: timeline.map((timelineItem, index) => {
      const item = assertRecord(timelineItem, `overview.timeline[${index}]`);

      return {
        timeSeconds: assertNumber(item.timeSeconds, `overview.timeline[${index}].timeSeconds`),
        title: assertString(item.title, `overview.timeline[${index}].title`),
        description: assertString(item.description, `overview.timeline[${index}].description`)
      };
    }),
    mindmapMermaid: assertString(overview.mindmapMermaid, "overview.mindmapMermaid")
  };
}

export function validateOverviewChunk(value: unknown): OverviewChunk {
  const root = assertRecord(value, "root");
  const chunk = assertRecord(root.chunk, "chunk");

  return {
    chunkIndex: assertNumber(chunk.chunkIndex, "chunk.chunkIndex"),
    startTime: assertNumber(chunk.startTime, "chunk.startTime"),
    endTime: assertNumber(chunk.endTime, "chunk.endTime"),
    summary: assertString(chunk.summary, "chunk.summary"),
    keyPoints: assertStringArray(chunk.keyPoints, "chunk.keyPoints")
  };
}

export function validateOrganizedNote(value: unknown): string {
  const root = assertRecord(value, "root");
  return assertString(root.organizedText, "organizedText");
}

export function validateAnswer(value: unknown): string {
  const root = assertRecord(value, "root");
  return assertString(root.answer, "answer");
}

export function validateVocabularyItem(value: unknown): VocabularyItem {
  const root = assertRecord(value, "root");
  const item = assertRecord(root.item, "item");

  return {
    normalizedText: assertString(item.normalizedText, "item.normalizedText"),
    meaningZh: assertString(item.meaningZh, "item.meaningZh")
  };
}

export function validateVocabularyExamples(value: unknown): VocabularyExample[] {
  const root = assertRecord(value, "root");
  const examples = root.examples;

  if (!Array.isArray(examples) || examples.length === 0) {
    throw new InvalidModelOutputError("examples must be a non-empty array");
  }

  return examples.slice(0, 3).map((example, index) => {
    const item = assertRecord(example, `examples[${index}]`);

    return {
      en: assertString(item.en, `examples[${index}].en`),
      zh: assertString(item.zh, `examples[${index}].zh`)
    };
  });
}

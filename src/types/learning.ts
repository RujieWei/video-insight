export type SubtitleSegment = {
  startTime: number;
  endTime: number;
  englishText: string;
  chineseText: string;
  keywords?: string[];
};

export type LearningOverview = {
  summary: string;
  chapters: Array<{
    title: string;
    startTime: number;
    endTime: number;
    summary: string;
    keyPoints: string[];
  }>;
  timeline?: Array<{
    timeSeconds: number;
    title: string;
    description: string;
  }>;
  mindmapMermaid?: string;
};

import type { LearningOverview, SubtitleSegment } from "../types/learning";

export type OverviewSourceSegment = Pick<SubtitleSegment, "startTime" | "endTime" | "englishText">;

export type OverviewChunkInput = {
  chunkIndex: number;
  segments: OverviewSourceSegment[];
};

export type OverviewChunkResult = {
  chunkIndex: number;
  startTime: number;
  endTime: number;
  summary: string;
  keyPoints: string[];
};

export function toOverviewSourceSegments(segments: SubtitleSegment[]): OverviewSourceSegment[] {
  return segments.map((segment) => ({
    startTime: segment.startTime,
    endTime: segment.endTime,
    englishText: segment.englishText
  }));
}

export function getOverviewCharacterCount(segments: OverviewSourceSegment[]) {
  return segments.reduce((sum, segment) => sum + segment.englishText.length, 0);
}

export function chunkOverviewSegments(
  segments: OverviewSourceSegment[],
  {
    maxSegments,
    maxCharacters
  }: {
    maxSegments: number;
    maxCharacters: number;
  }
) {
  const chunks: OverviewChunkInput[] = [];
  let currentSegments: OverviewSourceSegment[] = [];
  let currentLength = 0;

  for (const segment of segments) {
    const segmentLength = segment.englishText.length;
    const nextLength = currentLength + segmentLength;

    if (
      currentSegments.length > 0 &&
      (currentSegments.length >= maxSegments || nextLength > maxCharacters)
    ) {
      chunks.push({
        chunkIndex: chunks.length,
        segments: currentSegments
      });
      currentSegments = [];
      currentLength = 0;
    }

    currentSegments.push(segment);
    currentLength += segmentLength;
  }

  if (currentSegments.length > 0) {
    chunks.push({
      chunkIndex: chunks.length,
      segments: currentSegments
    });
  }

  return chunks;
}

export async function runOverviewChunkQueue({
  chunks,
  concurrency,
  generateChunk
}: {
  chunks: OverviewChunkInput[];
  concurrency: number;
  generateChunk: (chunk: OverviewChunkInput) => Promise<OverviewChunkResult>;
}) {
  const results: OverviewChunkResult[] = [];
  let cursor = 0;

  async function worker() {
    while (cursor < chunks.length) {
      const chunk = chunks[cursor];
      cursor += 1;
      results.push(await generateChunk(chunk));
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, chunks.length)) }, () => worker())
  );

  return results.sort((left, right) => left.chunkIndex - right.chunkIndex);
}

function combineKeyPoints(chunks: OverviewChunkResult[]) {
  const keyPoints = chunks.flatMap((chunk) => chunk.keyPoints).filter(Boolean);
  return keyPoints.slice(0, 3);
}

export function createFallbackOverviewFromChunks(
  chunks: OverviewChunkResult[],
  videoTitle?: string
): LearningOverview {
  if (chunks.length === 0) {
    throw new Error("Cannot create fallback overview without overview chunks");
  }

  const orderedChunks = chunks.slice().sort((left, right) => left.chunkIndex - right.chunkIndex);
  const summary = orderedChunks
    .map((chunk) => chunk.summary)
    .filter(Boolean)
    .slice(0, 5)
    .join(" ");
  const chapterGroupSize = Math.max(1, Math.ceil(orderedChunks.length / 6));
  const chapters: LearningOverview["chapters"] = [];

  for (let index = 0; index < orderedChunks.length; index += chapterGroupSize) {
    const group = orderedChunks.slice(index, index + chapterGroupSize);
    const firstChunk = group[0];
    const lastChunk = group[group.length - 1];

    chapters.push({
      title: `第 ${chapters.length + 1} 部分`,
      startTime: firstChunk.startTime,
      endTime: lastChunk.endTime,
      summary: group.map((chunk) => chunk.summary).join(" "),
      keyPoints: combineKeyPoints(group)
    });
  }

  return {
    titleZh: "视频学习总览",
    summary,
    chapters
  };
}

import type { SubtitleSegment } from "../types/learning";

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

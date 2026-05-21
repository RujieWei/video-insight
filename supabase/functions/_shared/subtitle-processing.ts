import type { RawSubtitleSegment } from "./ai-schemas.ts";

export const SUBTITLE_TRANSLATION_BATCH_MAX_SEGMENTS = 12;
export const SUBTITLE_TRANSLATION_BATCH_MAX_CHARACTERS = 1500;

export type PreparedSubtitleSegment = {
  index: number;
  startTime: number;
  endTime: number;
  englishText: string;
};

export type SubtitleTranslationBatch = {
  batchIndex: number;
  segments: PreparedSubtitleSegment[];
};

function normalizeSubtitleText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function splitIntoSentencePieces(segment: RawSubtitleSegment): RawSubtitleSegment[] {
  const text = normalizeSubtitleText(segment.text);

  if (!text) {
    return [];
  }

  const matches = text.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g);

  if (!matches || matches.length <= 1) {
    return [{ ...segment, text }];
  }

  const duration = Math.max(0.1, segment.endTime - segment.startTime);
  let cursor = segment.startTime;
  const totalLength = matches.reduce((sum, item) => sum + item.length, 0);

  return matches.map((item, index) => {
    const pieceText = normalizeSubtitleText(item);
    const pieceDuration =
      index === matches.length - 1 ? segment.endTime - cursor : duration * (item.length / totalLength);
    const startTime = cursor;
    const endTime = Math.min(segment.endTime, cursor + Math.max(0.1, pieceDuration));
    cursor = endTime;

    return {
      startTime,
      endTime,
      text: pieceText
    };
  });
}

export function prepareSubtitleSegments(rawSegments: RawSubtitleSegment[]): PreparedSubtitleSegment[] {
  const pieces = rawSegments
    .slice()
    .sort((left, right) => left.startTime - right.startTime)
    .flatMap(splitIntoSentencePieces);
  const prepared: PreparedSubtitleSegment[] = [];
  let bufferText = "";
  let bufferStartTime: number | null = null;
  let bufferEndTime: number | null = null;

  function flush() {
    const englishText = normalizeSubtitleText(bufferText);

    if (englishText && bufferStartTime !== null && bufferEndTime !== null) {
      prepared.push({
        index: prepared.length,
        startTime: bufferStartTime,
        endTime: bufferEndTime,
        englishText
      });
    }

    bufferText = "";
    bufferStartTime = null;
    bufferEndTime = null;
  }

  for (const piece of pieces) {
    const text = normalizeSubtitleText(piece.text);

    if (!text) {
      continue;
    }

    const gap = bufferEndTime === null ? 0 : piece.startTime - bufferEndTime;

    if (bufferText && gap > 1.5) {
      flush();
    }

    if (bufferStartTime === null) {
      bufferStartTime = piece.startTime;
    }

    bufferText = normalizeSubtitleText(`${bufferText} ${text}`);
    bufferEndTime = piece.endTime;

    const endsSentence = /[.!?]["')\]]?$/.test(bufferText);
    const isLongEnough = bufferText.length >= 35;
    const isTooLong = bufferText.length >= 220;

    if ((endsSentence && isLongEnough) || isTooLong) {
      flush();
    }
  }

  flush();

  return prepared;
}

export function prepareSubtitleTranslationBatches(rawSegments: RawSubtitleSegment[]): SubtitleTranslationBatch[] {
  const batches: SubtitleTranslationBatch[] = [];
  let currentBatch: PreparedSubtitleSegment[] = [];
  let currentLength = 0;

  for (const segment of prepareSubtitleSegments(rawSegments)) {
    const nextLength = currentLength + segment.englishText.length;

    if (
      currentBatch.length > 0 &&
      (currentBatch.length >= SUBTITLE_TRANSLATION_BATCH_MAX_SEGMENTS ||
        nextLength > SUBTITLE_TRANSLATION_BATCH_MAX_CHARACTERS)
    ) {
      batches.push({
        batchIndex: batches.length,
        segments: currentBatch
      });
      currentBatch = [];
      currentLength = 0;
    }

    currentBatch.push(segment);
    currentLength += segment.englishText.length;
  }

  if (currentBatch.length > 0) {
    batches.push({
      batchIndex: batches.length,
      segments: currentBatch
    });
  }

  return batches;
}

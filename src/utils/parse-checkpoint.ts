import type { SubtitleSegment } from "../types/learning";

export type BatchLike = {
  batchIndex: number;
  segments: unknown[];
};

export type CompletedBatchResult = {
  batchIndex: number;
  segments: SubtitleSegment[];
};

export type ParseCheckpointStatus = "translating" | "partially_completed" | "completed" | "failed";

export type ParseCheckpoint<TVideoInfo = unknown, TBatch extends BatchLike = BatchLike> = {
  videoInfo: TVideoInfo;
  batches: TBatch[];
  completedBatchResults: CompletedBatchResult[];
  failedBatchIndexes: number[];
  status: ParseCheckpointStatus;
  updatedAt: number;
};

export function mergeCompletedBatchResults(completedBatchResults: CompletedBatchResult[]) {
  return completedBatchResults
    .slice()
    .sort((left, right) => left.batchIndex - right.batchIndex)
    .flatMap((result) => result.segments);
}

export function upsertCompletedBatchResult(
  completedBatchResults: CompletedBatchResult[],
  nextResult: CompletedBatchResult
) {
  return [
    ...completedBatchResults.filter((result) => result.batchIndex !== nextResult.batchIndex),
    nextResult
  ].sort((left, right) => left.batchIndex - right.batchIndex);
}

export function getPendingBatchIndexes<TBatch extends BatchLike>(
  batches: TBatch[],
  completedBatchResults: CompletedBatchResult[],
  failedBatchIndexes: number[]
) {
  const completedBatchIndexes = new Set(completedBatchResults.map((result) => result.batchIndex));
  const failedBatchIndexSet = new Set(failedBatchIndexes);

  return batches
    .map((batch) => batch.batchIndex)
    .filter((batchIndex) => !completedBatchIndexes.has(batchIndex) || failedBatchIndexSet.has(batchIndex));
}

export async function runSubtitleBatchQueue<TBatch extends BatchLike>({
  batches,
  concurrency,
  translateBatch,
  initialCompletedBatchResults = [],
  onBatchComplete,
  onBatchFailed
}: {
  batches: TBatch[];
  concurrency: number;
  translateBatch: (batch: TBatch) => Promise<SubtitleSegment[]>;
  initialCompletedBatchResults?: CompletedBatchResult[];
  onBatchComplete?: (result: CompletedBatchResult) => void | Promise<void>;
  onBatchFailed?: (batchIndex: number, error: unknown) => void | Promise<void>;
}) {
  const completedBatchResults = initialCompletedBatchResults.slice();
  const failedBatchIndexes: number[] = [];
  let cursor = 0;

  async function worker() {
    while (cursor < batches.length) {
      const batch = batches[cursor];
      cursor += 1;

      try {
        const segments = await translateBatch(batch);
        const result = { batchIndex: batch.batchIndex, segments };
        const existingIndex = completedBatchResults.findIndex(
          (completedResult) => completedResult.batchIndex === result.batchIndex
        );

        if (existingIndex >= 0) {
          completedBatchResults[existingIndex] = result;
        } else {
          completedBatchResults.push(result);
        }

        await onBatchComplete?.(result);
      } catch (error) {
        failedBatchIndexes.push(batch.batchIndex);
        await onBatchFailed?.(batch.batchIndex, error);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, batches.length)) }, () => worker())
  );

  return {
    completedBatchResults: completedBatchResults.sort((left, right) => left.batchIndex - right.batchIndex),
    failedBatchIndexes: failedBatchIndexes.sort((left, right) => left - right)
  };
}

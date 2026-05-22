import assert from "node:assert/strict";

import { formatDuration } from "../src/utils/time.ts";
import { isRetriableAiTaskError } from "../src/utils/ai-errors.ts";
import { findActiveSubtitleIndex } from "../src/utils/subtitles.ts";
import {
  getPendingBatchIndexes,
  mergeCompletedBatchResults,
  runSubtitleBatchQueue
} from "../src/utils/parse-checkpoint.ts";
import { validateOverview } from "../supabase/functions/_shared/ai-schemas.ts";
import {
  prepareSubtitleSegments,
  prepareSubtitleTranslationBatches,
  SUBTITLE_TRANSLATION_BATCH_MAX_CHARACTERS,
  SUBTITLE_TRANSLATION_BATCH_MAX_SEGMENTS
} from "../supabase/functions/_shared/subtitle-processing.ts";

assert.equal(formatDuration(4.88), "0:05");
assert.equal(formatDuration(67.5), "1:08");
assert.equal(formatDuration(3601.4), "1:00:01");
assert.equal(isRetriableAiTaskError(new Error("生成失败（INVALID_MODEL_OUTPUT）")), true);
assert.equal(isRetriableAiTaskError(new Error("生成失败（AI_TASK_FAILED）")), true);
assert.equal(isRetriableAiTaskError(new Error("当前视频无法解析：英文字幕内容为空。")), false);

const rawSegments = Array.from({ length: 72 }, (_, index) => ({
  startTime: index * 3,
  endTime: index * 3 + 2.4,
  text: `This is subtitle sentence number ${index + 1}, and it should be grouped into a stable translation batch.`
}));

const batches = prepareSubtitleTranslationBatches(rawSegments);

assert.ok(batches.length > 1, "long transcript should be split into multiple batches");

for (const batch of batches) {
  assert.ok(
    batch.segments.length <= SUBTITLE_TRANSLATION_BATCH_MAX_SEGMENTS,
    "batch should not exceed max segment count"
  );

  const characterCount = batch.segments.reduce((sum, segment) => sum + segment.englishText.length, 0);
  assert.ok(
    characterCount <= SUBTITLE_TRANSLATION_BATCH_MAX_CHARACTERS,
    "batch should not exceed max character count"
  );
}

assert.deepEqual(
  batches.flatMap((batch) => batch.segments.map((segment) => segment.index)),
  batches.flatMap((batch) => batch.segments).map((_, index) => index),
  "prepared segment indexes should be contiguous"
);

const overlappingPreparedSegments = prepareSubtitleSegments([
  {
    startTime: 341,
    endTime: 356,
    text: "And the reason why I even have this entire section is because it matters."
  },
  {
    startTime: 354,
    endTime: 360,
    text: "So you should learn how to actually use most useful hotkeys."
  }
]);

assert.equal(
  overlappingPreparedSegments[0].endTime,
  354,
  "prepared subtitle end time should stop at the next subtitle start when timings overlap"
);

assert.equal(
  findActiveSubtitleIndex(
    [
      { startTime: 341, endTime: 356, englishText: "previous", chineseText: "上一条" },
      { startTime: 354, endTime: 360, englishText: "next", chineseText: "下一条" }
    ],
    354
  ),
  1,
  "active subtitle should prefer the next subtitle once its start time is reached"
);

const outOfOrderMergedSegments = mergeCompletedBatchResults([
  {
    batchIndex: 2,
    segments: [
      { startTime: 20, endTime: 22, englishText: "third", chineseText: "第三句", keywords: [] }
    ]
  },
  {
    batchIndex: 0,
    segments: [
      { startTime: 0, endTime: 2, englishText: "first", chineseText: "第一句", keywords: [] }
    ]
  },
  {
    batchIndex: 1,
    segments: [
      { startTime: 10, endTime: 12, englishText: "second", chineseText: "第二句", keywords: [] }
    ]
  }
]);

assert.deepEqual(
  outOfOrderMergedSegments.map((segment) => segment.englishText),
  ["first", "second", "third"],
  "completed batch results should merge by batchIndex"
);

assert.deepEqual(
  getPendingBatchIndexes(
    [{ batchIndex: 0, segments: [] }, { batchIndex: 1, segments: [] }, { batchIndex: 2, segments: [] }],
    [{ batchIndex: 0, segments: [] }],
    [2]
  ),
  [1, 2],
  "checkpoint resume should continue missing and failed batches"
);

const queueEvents = [];
const queueResult = await runSubtitleBatchQueue({
  batches: [
    { batchIndex: 0, segments: [] },
    { batchIndex: 1, segments: [] },
    { batchIndex: 2, segments: [] },
    { batchIndex: 3, segments: [] }
  ],
  concurrency: 3,
  translateBatch: async (batch) => {
    if (batch.batchIndex === 2) {
      throw new Error("生成失败（AI_TASK_FAILED）");
    }

    await new Promise((resolve) => setTimeout(resolve, batch.batchIndex === 0 ? 20 : 1));

    return [
      {
        startTime: batch.batchIndex,
        endTime: batch.batchIndex + 1,
        englishText: `batch-${batch.batchIndex}`,
        chineseText: `批次-${batch.batchIndex}`,
        keywords: []
      }
    ];
  },
  onBatchComplete: (result) => {
    queueEvents.push(result.batchIndex);
  }
});

assert.deepEqual(queueResult.failedBatchIndexes, [2], "failed batch should be recorded");
assert.deepEqual(
  mergeCompletedBatchResults(queueResult.completedBatchResults).map((segment) => segment.englishText),
  ["batch-0", "batch-1", "batch-3"],
  "successful concurrent batches should be retained when another batch fails"
);
assert.ok(Math.max(...queueEvents) > Math.min(...queueEvents), "queue should report completed batches");

const overviewWithoutMindmap = validateOverview({
  overview: {
    summary: "这是一个总览。",
    chapters: [
      {
        title: "章节",
        startTime: 0,
        endTime: 10,
        summary: "章节摘要。",
        keyPoints: ["关键点"]
      }
    ],
    timeline: []
  }
});

assert.equal(overviewWithoutMindmap.mindmapMermaid, undefined);

console.log("Phase 11 smoke tests passed.");

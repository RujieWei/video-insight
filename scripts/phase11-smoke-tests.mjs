import assert from "node:assert/strict";

import { formatDuration } from "../src/utils/time.ts";
import { isRetriableAiTaskError } from "../src/utils/ai-errors.ts";
import {
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

console.log("Phase 11 smoke tests passed.");

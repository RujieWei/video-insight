import type { SubtitleSegment } from "../types/learning";

export function findActiveSubtitleIndex(
  subtitleSegments: Pick<SubtitleSegment, "startTime" | "endTime">[],
  currentPlaybackTime: number | null
) {
  if (currentPlaybackTime === null) {
    return -1;
  }

  return subtitleSegments.findIndex((segment, index) => {
    const nextSegment = subtitleSegments[index + 1];
    const effectiveEndTime =
      nextSegment && nextSegment.startTime > segment.startTime && nextSegment.startTime < segment.endTime
        ? nextSegment.startTime
        : segment.endTime;

    return currentPlaybackTime >= segment.startTime && currentPlaybackTime < effectiveEndTime;
  });
}

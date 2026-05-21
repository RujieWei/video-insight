export function formatDuration(durationSeconds: number | null) {
  if (durationSeconds === null) {
    return "读取中";
  }

  const roundedDurationSeconds = Math.max(0, Math.round(durationSeconds));
  const hours = Math.floor(roundedDurationSeconds / 3600);
  const minutes = Math.floor((roundedDurationSeconds % 3600) / 60);
  const seconds = roundedDurationSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

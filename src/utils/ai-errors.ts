export function isRetriableAiTaskError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("INVALID_MODEL_OUTPUT") ||
    error.message.includes("AI_TASK_FAILED") ||
    error.message.includes("429") ||
    /\b5\d\d\b/.test(error.message) ||
    error.message.includes("empty response") ||
    error.message.includes("invalid JSON")
  );
}

export function isRetriableAiTaskError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes("INVALID_MODEL_OUTPUT") || error.message.includes("AI_TASK_FAILED");
}

export type ParseStepStatus = "pending" | "processing" | "completed" | "failed";

type InternalParseStatuses = Record<string, ParseStepStatus>;

export type TranslationProgress = {
  completed: number;
  total: number;
};

export type ParseDisplayStep = {
  key: "fetch" | "translate" | "overview" | "save";
  label: string;
  status: ParseStepStatus;
};

const DISPLAY_STEP_WEIGHTS: Record<ParseDisplayStep["key"], number> = {
  fetch: 15,
  translate: 60,
  overview: 20,
  save: 5
};

function mergeStepStatuses(statuses: ParseStepStatus[]) {
  if (statuses.includes("failed")) {
    return "failed";
  }

  if (statuses.includes("processing")) {
    return "processing";
  }

  if (statuses.every((status) => status === "completed")) {
    return "completed";
  }

  return "pending";
}

export function getParseDisplaySteps(statuses: InternalParseStatuses): ParseDisplayStep[] {
  return [
    {
      key: "fetch",
      label: "获取字幕",
      status: statuses.fetch_captions ?? "pending"
    },
    {
      key: "translate",
      label: "翻译字幕",
      status: mergeStepStatuses([
        statuses.segment_subtitles ?? "pending",
        statuses.translate_subtitles ?? "pending"
      ])
    },
    {
      key: "overview",
      label: "生成总览",
      status: mergeStepStatuses([
        statuses.generate_summary ?? "pending",
        statuses.generate_chapters_timeline ?? "pending"
      ])
    },
    {
      key: "save",
      label: "保存结果",
      status: statuses.save_results ?? "pending"
    }
  ];
}

export function getParseDisplayProgress(
  statuses: InternalParseStatuses,
  translationProgress?: TranslationProgress
) {
  const steps = getParseDisplaySteps(statuses);
  const progress = steps.reduce((sum, step) => {
    const weight = DISPLAY_STEP_WEIGHTS[step.key];

    if (step.status === "completed") {
      return sum + weight;
    }

    if (step.key === "translate" && step.status === "processing" && translationProgress?.total) {
      const fraction = Math.min(
        Math.max(translationProgress.completed / translationProgress.total, 0),
        1
      );
      return sum + weight * fraction;
    }

    return sum;
  }, 0);

  return Math.round(Math.min(Math.max(progress, 0), 100));
}

export function getNonDecreasingProgress(previousProgress: number, nextProgress: number) {
  return Math.max(
    Math.min(Math.max(Math.round(previousProgress), 0), 100),
    Math.min(Math.max(Math.round(nextProgress), 0), 100)
  );
}

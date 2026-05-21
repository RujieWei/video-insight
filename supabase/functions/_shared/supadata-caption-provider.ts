import type { FetchTranscriptInput, TranscriptResult } from "./caption-provider.ts";
import { CaptionProviderError } from "./caption-provider.ts";

type SupadataTranscriptSegment = {
  text?: unknown;
  offset?: unknown;
  duration?: unknown;
};

type SupadataTranscriptResponse = {
  content?: unknown;
  lang?: unknown;
  availableLangs?: unknown;
  jobId?: unknown;
};

function toNumber(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function secondsFromSupadataTime(value: unknown) {
  const numericValue = toNumber(value);

  if (numericValue === null) {
    return null;
  }

  return numericValue > 1000 ? numericValue / 1000 : numericValue;
}

function validateTranscriptSegments(content: unknown) {
  if (!Array.isArray(content)) {
    throw new CaptionProviderError(
      "TRANSCRIPT_CONTENT_NOT_SEGMENTS",
      "Supadata 没有返回带时间戳的字幕片段。"
    );
  }

  const segments = content
    .map((item) => {
      const segment = item as SupadataTranscriptSegment;
      const text = typeof segment.text === "string" ? segment.text.replace(/\s+/g, " ").trim() : "";
      const startTime = secondsFromSupadataTime(segment.offset);
      const duration = secondsFromSupadataTime(segment.duration);

      if (!text || startTime === null) {
        return null;
      }

      const endTime = duration !== null && duration > 0 ? startTime + duration : startTime + 3;

      return {
        startTime,
        endTime,
        text
      };
    })
    .filter((segment): segment is { startTime: number; endTime: number; text: string } =>
      Boolean(segment)
    );

  if (segments.length === 0) {
    throw new CaptionProviderError(
      "TRANSCRIPT_EMPTY",
      "Supadata 没有返回可用的英文字幕正文。"
    );
  }

  return segments;
}

export class SupadataCaptionProvider {
  constructor(private readonly apiKey: string) {}

  private async readTranscriptJob(jobId: string) {
    const response = await fetch(`https://api.supadata.ai/v1/transcript/${jobId}`, {
      headers: {
        "x-api-key": this.apiKey
      }
    });

    if (!response.ok) {
      throw new CaptionProviderError(
        "SUPADATA_JOB_REQUEST_FAILED",
        `Supadata 字幕任务查询失败：${response.status}`
      );
    }

    return (await response.json()) as SupadataTranscriptResponse & {
      status?: string;
      error?: {
        message?: string;
      };
    };
  }

  private async waitForTranscriptJob(jobId: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await this.readTranscriptJob(jobId);

      if (result.status === "completed") {
        return result;
      }

      if (result.status === "failed") {
        throw new CaptionProviderError(
          "SUPADATA_JOB_FAILED",
          result.error?.message || "Supadata 字幕任务失败。"
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new CaptionProviderError(
      "SUPADATA_JOB_TIMEOUT",
      "Supadata 字幕任务超时。"
    );
  }

  async fetchTranscript(input: FetchTranscriptInput): Promise<TranscriptResult> {
    const url = new URL("https://api.supadata.ai/v1/transcript");
    url.searchParams.set("url", input.videoUrl);
    url.searchParams.set("lang", input.language);
    url.searchParams.set("text", "false");
    url.searchParams.set("mode", "native");

    const response = await fetch(url.toString(), {
      headers: {
        "x-api-key": this.apiKey
      }
    });

    if (!response.ok) {
      throw new CaptionProviderError(
        "SUPADATA_REQUEST_FAILED",
        `Supadata 请求失败：${response.status}`
      );
    }

    const initialData = (await response.json()) as SupadataTranscriptResponse;
    const data =
      typeof initialData.jobId === "string"
        ? await this.waitForTranscriptJob(initialData.jobId)
        : initialData;

    if (typeof data.lang === "string" && !data.lang.toLowerCase().startsWith("en")) {
      throw new CaptionProviderError(
        "TRANSCRIPT_LANGUAGE_UNAVAILABLE",
        "Supadata 没有返回英文字幕正文。"
      );
    }

    const segments = validateTranscriptSegments(data.content);

    return {
      provider: "supadata",
      mode: "native",
      language: "en",
      segments
    };
  }
}

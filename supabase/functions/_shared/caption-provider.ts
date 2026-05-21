import type { RawSubtitleSegment } from "./ai-schemas.ts";

export type FetchTranscriptInput = {
  videoUrl: string;
  videoId: string;
  language: "en";
};

export type TranscriptResult = {
  provider: "supadata";
  mode: "native";
  language: "en";
  segments: RawSubtitleSegment[];
};

export class CaptionProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "CaptionProviderError";
  }
}

export interface CaptionProvider {
  fetchTranscript(input: FetchTranscriptInput): Promise<TranscriptResult>;
}

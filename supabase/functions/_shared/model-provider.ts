import type {
  GeneratedOverview,
  GeneratedSubtitleSegment,
  RawSubtitleSegment,
  VocabularyExample,
  AnswerQuestionInput,
  GenerateVocabularyItemInput,
  VocabularyItem
} from "./ai-schemas.ts";

export type OrganizeNoteInput = {
  sourceText: string;
  sourceTranslation: string;
  previousOrganizedText?: string;
};

export type VocabularyExamplesInput = {
  text: string;
  type: "word" | "phrase";
  meaningZh: string;
  sourceSentence: string;
  sourceTranslation: string;
  videoContext: string;
  existingExamples: VocabularyExample[];
};

export interface ModelProvider {
  segmentAndTranslateSubtitles(rawSegments: RawSubtitleSegment[]): Promise<GeneratedSubtitleSegment[]>;
  generateOverview(segments: GeneratedSubtitleSegment[]): Promise<GeneratedOverview>;
  organizeNote(input: OrganizeNoteInput): Promise<string>;
  answerQuestion(input: AnswerQuestionInput): Promise<string>;
  generateVocabularyItem(input: GenerateVocabularyItemInput): Promise<VocabularyItem>;
  generateVocabularyExamples(input: VocabularyExamplesInput): Promise<VocabularyExample[]>;
}

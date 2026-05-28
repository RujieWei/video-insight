import {
  validateAnswer,
  validateOverviewChunk,
  validateOrganizedNote,
  validateOverview,
  validateSubtitleTranslations,
  validateVocabularyExamples,
  validateVocabularyItem,
  InvalidModelOutputError,
  type AnswerQuestionInput,
  type GenerateVocabularyItemInput,
  type GeneratedSubtitleSegment,
  type OverviewSubtitleSegment,
  type OverviewChunk,
  type RawSubtitleSegment
} from "./ai-schemas.ts";
import type {
  ModelProvider,
  OrganizeNoteInput,
  VocabularyExamplesInput
} from "./model-provider.ts";
import {
  prepareSubtitleTranslationBatches,
  type SubtitleTranslationBatch
} from "./subtitle-processing.ts";

type DeepSeekChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
    finish_reason?: string;
  }>;
};

export class DeepSeekProvider implements ModelProvider {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model = "deepseek-v4-flash") {
    this.apiKey = apiKey;
    this.model = model;
  }

  async segmentAndTranslateSubtitles(rawSegments: RawSubtitleSegment[]) {
    const batches = prepareSubtitleTranslationBatches(rawSegments);

    if (batches.length === 0) {
      throw new Error("No subtitle segments to translate");
    }

    const translatedSegments: GeneratedSubtitleSegment[] = [];

    for (const batch of batches) {
      translatedSegments.push(...await this.translateSubtitleBatch(batch));
    }

    return translatedSegments;
  }

  async translateSubtitleBatch(batch: SubtitleTranslationBatch) {
    const payload = await this.callJson(
      "你是一个专业的英文视频字幕中文翻译助手。你必须只输出合法 JSON 对象。",
      `请把输入字幕逐条翻译成自然中文。严格要求：不要新增、删除、合并、拆分字幕；必须保留每条字幕的 index；translations 数量必须等于输入数量。严格输出 JSON 对象，格式为 {"translations":[{"index":0,"chineseText":"..."}]}。\n\n输入字幕：\n${JSON.stringify(batch.segments.map((segment) => ({ index: segment.index, englishText: segment.englishText })))}`
    );
    const translations = validateSubtitleTranslations(payload);
    const translationByIndex = new Map(translations.map((translation) => [translation.index, translation]));

    return batch.segments.map((segment) => {
      const translation = translationByIndex.get(segment.index);

      if (!translation) {
        throw new InvalidModelOutputError(`DeepSeek translation missing segment index ${segment.index}`);
      }

      return {
        startTime: segment.startTime,
        endTime: segment.endTime,
        englishText: segment.englishText,
        chineseText: translation.chineseText,
        keywords: translation.keywords
      };
    });
  }

  async generateOverview(segments: OverviewSubtitleSegment[], videoTitle?: string) {
    const payload = await this.callJson(
      "你是一个面向 AI 产品经理、创业者和科技从业者的视频内容分析助手。你必须只输出合法 JSON 对象。",
      `请基于英文标题和英文字幕生成中文学习总览。不要编造字幕之外的信息。严格输出 JSON 对象，不要输出解释文字。要求：titleZh 是英文标题的自然中文短标题；summary 为 3-5 句中文；chapters 必须输出 5-8 个；每个章节必须有 title、startTime、endTime、summary、keyPoints；keyPoints 必须有 2-3 条；章节时间必须落在输入字幕时间范围内。输出格式只能是 {"overview":{"titleZh":"...","summary":"...","chapters":[{"title":"...","startTime":0,"endTime":300,"summary":"...","keyPoints":["...","..."]}]}}。\n\n输入：\n${JSON.stringify({ videoTitle, segments })}`
    );

    return validateOverview(payload);
  }

  async generateOverviewChunk(input: {
    chunkIndex: number;
    segments: OverviewSubtitleSegment[];
  }) {
    const payload = await this.callJson(
      "你是一个面向 AI 产品经理、创业者和科技从业者的视频内容分析助手。你必须只输出合法 JSON 对象。",
      `请只基于这一小段英文字幕生成中文分段摘要。不要生成章节，不要生成标题，不要编造字幕之外的信息。严格输出 JSON 对象，不要输出解释文字。要求：chunkIndex 必须等于输入 chunkIndex；startTime 使用第一条字幕 startTime；endTime 使用最后一条字幕 endTime；summary 为 1-2 句中文；keyPoints 必须有 2-3 条。输出格式只能是 {"chunk":{"chunkIndex":0,"startTime":0,"endTime":300,"summary":"...","keyPoints":["...","..."]}}。\n\n输入：\n${JSON.stringify(input)}`,
      1600
    );

    return validateOverviewChunk(payload);
  }

  async generateOverviewFromChunks(chunks: OverviewChunk[], videoTitle?: string) {
    const payload = await this.callJson(
      "你是一个面向 AI 产品经理、创业者和科技从业者的视频内容分析助手。你必须只输出合法 JSON 对象。",
      `请只基于输入的分段摘要生成最终中文学习总览，不要回看或假设原字幕，不要编造分段摘要之外的信息。严格输出 JSON 对象，不要输出解释文字。要求：titleZh 是英文标题的自然中文短标题；summary 为 3-5 句中文；chapters 必须输出 5-8 个，如果分段数量少于 5 个则按分段数量输出；每个章节必须有 title、startTime、endTime、summary、keyPoints；keyPoints 必须有 2-3 条；章节时间必须落在输入 chunks 的时间范围内。输出格式只能是 {"overview":{"titleZh":"...","summary":"...","chapters":[{"title":"...","startTime":0,"endTime":300,"summary":"...","keyPoints":["...","..."]}]}}。\n\n输入：\n${JSON.stringify({ videoTitle, chunks })}`
    );

    return validateOverview(payload);
  }

  async organizeNote(input: OrganizeNoteInput) {
    const payload = await this.callJson(
      "你是一个专业的学习笔记整理助手。你必须只输出合法 JSON 对象。",
      `请把用户选中的英文字幕整理成适合沉淀的中文笔记，不改变原意，不添加字幕外信息，控制在 1-3 句话。严格输出 JSON 对象，格式为 {"organizedText":"..."}。\n\n输入：\n${JSON.stringify(input)}`
    );

    return validateOrganizedNote(payload);
  }

  async answerQuestion(input: AnswerQuestionInput) {
    const payload = await this.callJson(
      "你是一个帮助中文用户学习 YouTube 英文视频的 AI 助手。回答要基于给定视频上下文，不要编造字幕之外的信息。你必须只输出合法 JSON 对象。",
      `请回答用户关于当前视频的问题。用中文回答，解释要具体、自然，适合产品经理理解；如果上下文不足，请明确说明不足。严格输出 JSON 对象，格式为 {"answer":"..."}。\n\n输入：\n${JSON.stringify(input)}`
    );

    return validateAnswer(payload);
  }

  async generateVocabularyItem(input: GenerateVocabularyItemInput) {
    const payload = await this.callJson(
      "你是一个英语生词整理助手。你必须只输出合法 JSON 对象。",
      `请基于用户选中的英文文本生成一个生词条目。你只负责规范化文本和中文释义，不要判断 word/phrase 类型，不要生成语境解释，不要生成例句。严格遵守：normalizedText 必须以用户选区为准；不要提取选区之外的新词；只有用户明显漏选单词前几个字母时，才允许保守补全该单词；如果选区是固定搭配的具体形式，可以规范成语法模式，例如 selectedText 为 "instead of asking" 时，normalizedText 可返回 "instead of + doing"。严格输出 JSON 对象，格式为 {"item":{"normalizedText":"...","meaningZh":"..."}}。\n\n输入：\n${JSON.stringify(input)}`,
      700
    );

    return validateVocabularyItem(payload);
  }

  async generateVocabularyExamples(input: VocabularyExamplesInput) {
    const payload = await this.callJson(
      "你是一个英语例句生成助手。你必须只输出合法 JSON 对象。",
      `请为这个单词或短语生成 3 组新的英文例句和中文翻译。要求：不要重复 sourceSentence，不要照抄已有例句；例句自然、短、贴近科技/产品/学习语境。严格输出 JSON 对象，格式为 {"examples":[{"en":"...","zh":"..."}]}。\n\n输入：\n${JSON.stringify(input)}`,
      1000
    );

    return validateVocabularyExamples(payload);
  }

  private async callJson(systemPrompt: string, userPrompt: string, maxTokens = 4096): Promise<unknown> {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: maxTokens,
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(`DeepSeek API request failed with status ${response.status}`);
    }

    const data = await response.json() as DeepSeekChatResponse;
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("DeepSeek API returned an empty response");
    }

    try {
      return JSON.parse(content);
    } catch {
      throw new Error("DeepSeek API returned invalid JSON");
    }
  }
}

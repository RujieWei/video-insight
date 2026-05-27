import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { DeepSeekProvider } from "../_shared/deepseek-provider.ts";
import { InvalidModelOutputError } from "../_shared/ai-schemas.ts";
import { CaptionProviderError } from "../_shared/caption-provider.ts";
import { SupadataCaptionProvider } from "../_shared/supadata-caption-provider.ts";
import { prepareSubtitleTranslationBatches } from "../_shared/subtitle-processing.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}

function getProvider() {
  const apiKey = Deno.env.get("DEEPSEEK_API_KEY");

  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is not configured");
  }

  return new DeepSeekProvider(apiKey, Deno.env.get("DEEPSEEK_MODEL") ?? "deepseek-v4-flash");
}

function getCaptionProvider() {
  const apiKey = Deno.env.get("SUPADATA_API_KEY");

  if (!apiKey) {
    throw new CaptionProviderError(
      "SUPADATA_API_KEY_MISSING",
      "SUPADATA_API_KEY is not configured"
    );
  }

  return new SupadataCaptionProvider(apiKey);
}

serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ ok: false, message: "Method not allowed" }, 405);
  }

  try {
    const { task, payload } = await request.json();

    if (task === "fetchTranscript") {
      const transcript = await getCaptionProvider().fetchTranscript(payload);
      return jsonResponse({ ok: true, data: { transcript } });
    }

    if (task === "prepareSubtitleTranslationBatches") {
      const batches = prepareSubtitleTranslationBatches(payload.rawSegments);
      return jsonResponse({ ok: true, data: { batches } });
    }

    const provider = getProvider();

    if (task === "segmentAndTranslateSubtitles") {
      const segments = await provider.segmentAndTranslateSubtitles(payload.rawSegments);
      return jsonResponse({ ok: true, data: { segments } });
    }

    if (task === "translateSubtitleBatch") {
      const segments = await provider.translateSubtitleBatch(payload.batch);
      return jsonResponse({ ok: true, data: { segments } });
    }

    if (task === "generateOverview") {
      const overview = await provider.generateOverview(payload.segments, payload.videoTitle);
      return jsonResponse({ ok: true, data: { overview } });
    }

    if (task === "generateOverviewChunk") {
      const chunk = await provider.generateOverviewChunk(payload);
      return jsonResponse({ ok: true, data: { chunk } });
    }

    if (task === "generateOverviewFromChunks") {
      const overview = await provider.generateOverviewFromChunks(payload.chunks, payload.videoTitle);
      return jsonResponse({ ok: true, data: { overview } });
    }

    if (task === "organizeNote") {
      const organizedText = await provider.organizeNote(payload);
      return jsonResponse({ ok: true, data: { organizedText } });
    }

    if (task === "answerQuestion") {
      const answer = await provider.answerQuestion(payload);
      return jsonResponse({ ok: true, data: { answer } });
    }

    if (task === "generateVocabularyItem") {
      const item = await provider.generateVocabularyItem(payload);
      return jsonResponse({ ok: true, data: { item } });
    }

    if (task === "generateVocabularyExamples") {
      const examples = await provider.generateVocabularyExamples(payload);
      return jsonResponse({ ok: true, data: { examples } });
    }

    return jsonResponse({ ok: false, message: "Unknown AI task" }, 400);
  } catch (error) {
    if (error instanceof InvalidModelOutputError) {
      return jsonResponse({ ok: false, errorCode: "INVALID_MODEL_OUTPUT", message: "生成失败" }, 422);
    }

    if (error instanceof CaptionProviderError) {
      return jsonResponse(
        {
          ok: false,
          errorCode: error.code,
          message: error.message || "没有成功获取英文字幕正文。"
        },
        422
      );
    }

    console.error("ai-tasks failed", {
      task,
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error)
    });

    return jsonResponse({ ok: false, errorCode: "AI_TASK_FAILED", message: "生成失败" }, 500);
  }
});

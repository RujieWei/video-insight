const VIDEO_INFO_REQUEST = "VIDEO_INSIGHT_GET_VIDEO_INFO";
const VIDEO_INFO_UPDATED = "VIDEO_INSIGHT_VIDEO_INFO_UPDATED";
const PLAYBACK_TIME_UPDATED = "VIDEO_INSIGHT_PLAYBACK_TIME_UPDATED";
const SEEK_TO_TIME = "VIDEO_INSIGHT_SEEK_TO_TIME";
const ENGLISH_CAPTIONS_REQUEST = "VIDEO_INSIGHT_GET_ENGLISH_CAPTIONS";

let lastVideoInfoJson = "";
let lastPlaybackTime = null;

function sendRuntimeMessage(message) {
  try {
    if (typeof chrome === "undefined" || !chrome.runtime?.id) {
      return;
    }

    chrome.runtime.sendMessage(message, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    // Old content scripts can keep running briefly after the extension is reloaded.
  }
}

function parseVideoId(urlString) {
  try {
    const url = new URL(urlString);
    if (!url.hostname.includes("youtube.com") || url.pathname !== "/watch") {
      return null;
    }

    return url.searchParams.get("v");
  } catch {
    return null;
  }
}

function cleanTitle(title) {
  return title.replace(/\s+-\s+YouTube$/, "").trim();
}

function readTitle() {
  const headingTitle = document.querySelector("h1 yt-formatted-string")?.textContent;
  const metaTitle = document.querySelector("meta[property='og:title']")?.getAttribute("content");
  const fallbackTitle = document.title;

  return cleanTitle(headingTitle || metaTitle || fallbackTitle || "");
}

function readChannelName() {
  return (
    document.querySelector("#owner #channel-name a")?.textContent?.trim() ||
    document.querySelector("ytd-video-owner-renderer a.yt-simple-endpoint")?.textContent?.trim() ||
    document.querySelector("meta[itemprop='author']")?.getAttribute("content") ||
    ""
  );
}

function readDurationSeconds() {
  const video = document.querySelector("video");
  if (!video || !Number.isFinite(video.duration)) {
    return null;
  }

  return Math.round(video.duration);
}

function getVideoElement() {
  return document.querySelector("video");
}

function collectVideoInfo() {
  const videoId = parseVideoId(window.location.href);
  const isYouTubeVideoPage = Boolean(videoId);

  return {
    isYouTubeVideoPage,
    videoId,
    url: window.location.href,
    title: isYouTubeVideoPage ? readTitle() : "",
    durationSeconds: isYouTubeVideoPage ? readDurationSeconds() : null,
    channelName: isYouTubeVideoPage ? readChannelName() : "",
    thumbnailUrl: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "",
    collectedAt: Date.now()
  };
}

function collectPlaybackTime() {
  const videoId = parseVideoId(window.location.href);
  const video = getVideoElement();

  if (!videoId || !video || !Number.isFinite(video.currentTime)) {
    return null;
  }

  return {
    videoId,
    currentTime: video.currentTime,
    collectedAt: Date.now()
  };
}

function extractJsonObjectAfterMarker(source, marker) {
  const markerIndex = source.indexOf(marker);

  if (markerIndex < 0) {
    return null;
  }

  const startIndex = source.indexOf("{", markerIndex);

  if (startIndex < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (char === "\\") {
        isEscaped = true;
      } else if (char === "\"") {
        inString = false;
      }

      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return source.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function parseInitialPlayerResponseFromText(text) {
  if (!text.includes("ytInitialPlayerResponse")) {
    return null;
  }

  const jsonText = extractJsonObjectAfterMarker(text, "ytInitialPlayerResponse");

  if (!jsonText) {
    return null;
  }

  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function readPlayerResponseFromPlayerElement() {
  const player = document.querySelector("#movie_player");

  if (typeof player?.getPlayerResponse !== "function") {
    return null;
  }

  try {
    return player.getPlayerResponse();
  } catch {
    return null;
  }
}

function readInitialPlayerResponse() {
  const playerResponse = readPlayerResponseFromPlayerElement();

  if (playerResponse) {
    return playerResponse;
  }

  for (const script of Array.from(document.scripts)) {
    const scriptPlayerResponse = parseInitialPlayerResponseFromText(script.textContent || "");

    if (scriptPlayerResponse) {
      return scriptPlayerResponse;
    }
  }

  return null;
}

async function fetchInitialPlayerResponseFromWatchPage() {
  const watchUrl = new URL(window.location.href);
  watchUrl.searchParams.set("hl", "en");

  const response = await fetch(watchUrl.toString(), {
    credentials: "include"
  });

  if (!response.ok) {
    return null;
  }

  return parseInitialPlayerResponseFromText(await response.text());
}

function chooseEnglishCaptionTrack(captionTracks) {
  const englishTracks = captionTracks.filter((track) => {
    const languageCode = String(track.languageCode || "").toLowerCase();
    return languageCode === "en" || languageCode.startsWith("en-");
  });

  if (englishTracks.length === 0) {
    return null;
  }

  return englishTracks.find((track) => track.kind !== "asr") || englishTracks[0];
}

function normalizeCaptionText(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .trim();
}

async function fetchEnglishCaptions() {
  let playerResponse = readInitialPlayerResponse();
  let captionTracks =
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

  if (captionTracks.length === 0) {
    playerResponse = await fetchInitialPlayerResponseFromWatchPage();
    captionTracks =
      playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  }

  const selectedTrack = chooseEnglishCaptionTrack(captionTracks);

  if (!selectedTrack?.baseUrl) {
    return {
      ok: false,
      errorCode: "NO_ENGLISH_CAPTIONS",
      message: "当前视频无法解析：没有可获取的英文字幕。"
    };
  }

  const captionUrl = new URL(selectedTrack.baseUrl);
  captionUrl.searchParams.set("fmt", "json3");

  const response = await fetch(captionUrl.toString(), {
    credentials: "include"
  });

  if (!response.ok) {
    return {
      ok: false,
      errorCode: "CAPTION_REQUEST_FAILED",
      message: "当前视频无法解析：英文字幕请求失败。"
    };
  }

  const data = await response.json();
  const segments = (data.events || [])
    .map((event) => {
      const text = normalizeCaptionText(
        (event.segs || []).map((segment) => segment.utf8 || "").join("")
      );
      const startTime = Number(event.tStartMs) / 1000;
      const duration = Number(event.dDurationMs || 0) / 1000;

      return {
        startTime,
        endTime: startTime + duration,
        text
      };
    })
    .filter((segment) => segment.text && Number.isFinite(segment.startTime) && Number.isFinite(segment.endTime));

  if (segments.length === 0) {
    return {
      ok: false,
      errorCode: "EMPTY_CAPTIONS",
      message: "当前视频无法解析：英文字幕内容为空。"
    };
  }

  return {
    ok: true,
    payload: {
      track: {
        languageCode: selectedTrack.languageCode || "",
        name: selectedTrack.name?.simpleText || selectedTrack.name?.runs?.map((run) => run.text).join("") || "",
        kind: selectedTrack.kind || "standard"
      },
      segments
    }
  };
}

function publishVideoInfoIfChanged() {
  const videoInfo = collectVideoInfo();
  const comparableInfo = { ...videoInfo, collectedAt: 0 };
  const nextVideoInfoJson = JSON.stringify(comparableInfo);

  if (nextVideoInfoJson === lastVideoInfoJson) {
    return;
  }

  lastVideoInfoJson = nextVideoInfoJson;
  sendRuntimeMessage({
    type: VIDEO_INFO_UPDATED,
    payload: videoInfo
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === VIDEO_INFO_REQUEST) {
    sendResponse({
      type: VIDEO_INFO_UPDATED,
      payload: collectVideoInfo()
    });

    return true;
  }

  if (message?.type === SEEK_TO_TIME) {
    const video = getVideoElement();
    const targetTime = Number(message.payload?.timeSeconds);

    if (video && Number.isFinite(targetTime)) {
      video.currentTime = Math.max(0, targetTime);
      publishPlaybackTime();
      sendResponse({ ok: true });
      return true;
    }

    sendResponse({ ok: false });
    return true;
  }

  if (message?.type === ENGLISH_CAPTIONS_REQUEST) {
    fetchEnglishCaptions()
      .then((result) => sendResponse(result))
      .catch(() => {
        sendResponse({
          ok: false,
          errorCode: "CAPTION_REQUEST_FAILED",
          message: "当前视频无法解析：英文字幕读取失败。"
        });
      });

    return true;
  }

  return false;
});

function publishPlaybackTime() {
  const playbackTime = collectPlaybackTime();

  if (!playbackTime) {
    lastPlaybackTime = null;
    return;
  }

  if (lastPlaybackTime !== null && Math.abs(playbackTime.currentTime - lastPlaybackTime) < 0.05) {
    return;
  }

  lastPlaybackTime = playbackTime.currentTime;
  sendRuntimeMessage({
    type: PLAYBACK_TIME_UPDATED,
    payload: playbackTime
  });
}

publishVideoInfoIfChanged();
window.addEventListener("yt-navigate-finish", publishVideoInfoIfChanged);
window.addEventListener("popstate", publishVideoInfoIfChanged);
setInterval(publishVideoInfoIfChanged, 1000);
setInterval(publishPlaybackTime, 200);

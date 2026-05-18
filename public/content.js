const VIDEO_INFO_REQUEST = "VIDEO_INSIGHT_GET_VIDEO_INFO";
const VIDEO_INFO_UPDATED = "VIDEO_INSIGHT_VIDEO_INFO_UPDATED";
const PLAYBACK_TIME_UPDATED = "VIDEO_INSIGHT_PLAYBACK_TIME_UPDATED";
const SEEK_TO_TIME = "VIDEO_INSIGHT_SEEK_TO_TIME";

let lastVideoInfoJson = "";
let lastPlaybackTime = null;

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

function publishVideoInfoIfChanged() {
  const videoInfo = collectVideoInfo();
  const comparableInfo = { ...videoInfo, collectedAt: 0 };
  const nextVideoInfoJson = JSON.stringify(comparableInfo);

  if (nextVideoInfoJson === lastVideoInfoJson) {
    return;
  }

  lastVideoInfoJson = nextVideoInfoJson;
  chrome.runtime.sendMessage({
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

  return false;
});

function publishPlaybackTime() {
  const playbackTime = collectPlaybackTime();

  if (!playbackTime) {
    lastPlaybackTime = null;
    return;
  }

  if (lastPlaybackTime !== null && Math.abs(playbackTime.currentTime - lastPlaybackTime) < 0.25) {
    return;
  }

  lastPlaybackTime = playbackTime.currentTime;
  chrome.runtime.sendMessage({
    type: PLAYBACK_TIME_UPDATED,
    payload: playbackTime
  });
}

publishVideoInfoIfChanged();
window.addEventListener("yt-navigate-finish", publishVideoInfoIfChanged);
window.addEventListener("popstate", publishVideoInfoIfChanged);
setInterval(publishVideoInfoIfChanged, 1000);
setInterval(publishPlaybackTime, 500);

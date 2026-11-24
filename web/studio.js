import { Inspector, precise } from "./inspector.js";
const $ = (id) => document.getElementById(id);
const pages = ["home", "library", "work"];
const formats = ["main", "short", "crop"];
let config = { speech: false, voice: false };
let current = null;
let mode = "main";
let playerView = "output";
let inputCaption = null;
let uploading = false;
let revisionPending = false;
let routeVersion = 0;
let timer;
let toastTimer;
let pendingSeek;
let resumePlayback = false;
let visible = "home";
let playerAsset = "";
const compatibleSources = new Set();
let preparingSource = false;
let editorSignature = "";
const player = $("player");

function time(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  return Math.floor(value / 60) + ":" + String(value % 60).padStart(2, "0");
}
function text(id, value) {
  $(id).textContent = value;
}
function node(tag, className, label) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (label != null) element.textContent = label;
  return element;
}
function toast(message) {
  clearTimeout(toastTimer);
  text("toast", message);
  $("toast").hidden = false;
  toastTimer = setTimeout(() => ($("toast").hidden = true), 4200);
}
async function api(path, options) {
  const response = await fetch(path, { cache: "no-store", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(typeof data.detail === "string" ? data.detail : "작업 요청을 처리하지 못했어요.");
    error.status = response.status;
    throw error;
  }
  return data;
}
const mediaUrl = (job, file) =>
  "/api/jobs/" + encodeURIComponent(job.id) + "/media/" + encodeURIComponent(file);
function playbackUrl(job, asset) {
  return asset === "source" && compatibleSources.has(job.id)
    ? "/api/jobs/" + encodeURIComponent(job.id) + "/editing-source"
    : mediaUrl(job, asset);
}
const stem = (name) => name.replace(/\.[a-z0-9]{2,5}$/i, "");
function show(page) {
  visible = page;
  for (const id of pages) $(id).hidden = id !== page;
  if (page !== "work") {
    player.pause();
    endAudition();
    closeFrame();
  }
  document.querySelectorAll("[data-nav]").forEach((link) => {
    if (link.dataset.nav === (page === "library" ? "library" : "studio"))
      link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}
function libraryList(container, jobs) {
  container.replaceChildren();
  if (!jobs.length) {
    container.append(
      node("p", "empty", "아직 편집한 영상이 없어요. 영상을 선택하거나 예시 수업으로 시작하세요."),
    );
    return;
  }
  for (const job of jobs) {
    const link = node("a", "job-item");
    link.href = "#job/" + job.id;
    const cover = node(job.poster || job.demo ? "img" : "span", "job-thumb");
    if (cover.tagName === "IMG") {
      cover.alt = "";
      cover.loading = "lazy";
      cover.src = job.poster ? mediaUrl(job, "poster.jpg") : "/demo-poster.jpg";
    }
    const group = node("span", "job-text");
    const stamp = new Date(job.created * 1000).toLocaleDateString("ko-KR", {
      month: "short",
      day: "numeric",
    });
    group.append(
      node("strong", "", stem(job.name)),
      node(
        "small",
        "",
        [job.demo ? "예시 수업" : "업로드", job.info && "원본 " + time(job.info.duration), stamp]
          .filter(Boolean)
          .join(" · "),
      ),
    );
    const status = node(
      "span",
      "pill " + job.status,
      job.status === "ready" ? "편집 완료" : job.status === "failed" ? "작업 중단" : "편집 중",
    );
    link.append(cover, group, status);
    container.append(link);
  }
}
async function refresh() {
  clearTimeout(timer);
  const token = ++routeVersion;
  const hash = location.hash.slice(1);
  window.scrollTo({ top: 0, behavior: "instant" });
  if (hash === "upload" && uploading) {
    show("work");
    return;
  }
  const project = /^job\/([a-f0-9]{32})(?:\/(main|short|crop))?$/.exec(hash);
  if (project) {
    const id = project[1],
      requestedMode = project[2] || "main";
    if (current?.id !== id) {
      current = null;
      inspector.reset();
      endAudition();
      closeFrame();
      mode = requestedMode;
      playerView = "output";
      editorSignature = "";
      playerAsset = "";
      preparingSource = false;
      player.pause();
      player.removeAttribute("src");
      player.load();
      $("editor").hidden = true;
      $("retry-box").hidden = true;
      $("progress-area").hidden = false;
      text("job-name", "작업 불러오는 중");
      text("job-meta", "");
      text("job-stage", "연결 중");
      text("progress-title", "작업 확인 중");
      $("progress").value = 0;
      text("percent", "");
      text("progress-detail", "");
    } else if (mode !== requestedMode) {
      endAudition();
      closeFrame();
      mode = requestedMode;
      playerView = "output";
      editorSignature = "";
    }
    show("work");
    await poll(id, token);
  } else {
    const page = hash === "library" ? "library" : "home";
    show(page);
    try {
      const jobs = await api("/api/jobs");
      if (token !== routeVersion) return;
      libraryList(
        page === "library" ? $("all-jobs") : $("recent"),
        page === "library" ? jobs : jobs.slice(0, 4),
      );
      if (jobs.some((job) => ["working", "queued"].includes(job.status))) {
        timer = setTimeout(async function updateList() {
          if (token !== routeVersion) return;
          try {
            const latest = await api("/api/jobs");
            if (token !== routeVersion) return;
            libraryList(
              page === "library" ? $("all-jobs") : $("recent"),
              page === "library" ? latest : latest.slice(0, 4),
            );
            if (latest.some((job) => ["working", "queued"].includes(job.status)))
              timer = setTimeout(updateList, 3500);
          } catch (e) {
            if (token === routeVersion) toast(e.message);
          }
        }, 3500);
      }
    } catch (e) {
      if (token === routeVersion) toast(e.message);
    }
  }
}
async function poll(id, token) {
  if (token !== routeVersion) return;
  try {
    const job = await api("/api/jobs/" + id);
    if (token !== routeVersion) return;
    current = job;
    paintJob();
    if (["queued", "working"].includes(job.status)) timer = setTimeout(() => poll(id, token), 1100);
  } catch (e) {
    if (token !== routeVersion) return;
    if (e.status === 404) {
      $("progress-area").hidden = true;
      text("job-name", "작업을 찾을 수 없어요");
      text("job-stage", "작업 없음");
      return;
    }
    text("progress-title", "작업 연결 확인 중");
    text("progress-detail", e.message);
    timer = setTimeout(() => poll(id, token), 4000);
  }
}
function paintJob() {
  const job = current;
  text("job-name", stem(job.name));
  text(
    "job-meta",
    [job.demo ? "예시 수업" : "업로드 영상", job.info && "원본 " + time(job.info.duration), job.method]
      .filter(Boolean)
      .join(" · "),
  );
  text("job-stage", job.stage);
  $("job-stage").className = "pill " + job.status;
  const busy = ["working", "queued"].includes(job.status);
  $("progress-area").hidden = !busy;
  $("progress").value = job.progress;
  text("percent", job.progress + "%");
  text("progress-title", job.stage);
  text(
    "progress-detail",
    job.progress < 42
      ? "원본을 읽고 편집에 사용할 구간을 찾고 있어요."
      : "구간의 순서와 자막을 적용해 재생 가능한 파일을 만들고 있어요.",
  );
  $("retry-box").hidden = !job.error;
  text("retry-text", job.error || "");
  $("retry").hidden = job.status !== "failed";
  const available = formats.filter((f) => job.outputs[f]);
  $("editor").hidden = !available.length;
  if (!available.length) return;
  if (!available.includes(mode)) mode = available[0];
  const signature = [
    job.id,
    job.status,
    mode,
    ...available.map((f) => job.outputs[f].editRevision || job.outputs[f].file),
  ].join("/");
  if (editorSignature !== signature) {
    editorSignature = signature;
    paintEditor();
  }
}
function selectPlayer(asset, at = 0, play = false) {
  const url = playbackUrl(current, asset);
  if (url === playerAsset && !player.error) {
    if (player.readyState && Number.isFinite(at))
      player.currentTime = Math.max(0, Math.min(at, player.duration || at));
    else {
      pendingSeek = at;
      resumePlayback = play;
    }
    if (play) player.play().catch(() => {});
    return;
  }
  playerAsset = url;
  preparingSource = asset === "source" && compatibleSources.has(current.id);
  pendingSeek = at;
  resumePlayback = play;
  const poster = asset === "source" ? "poster.jpg" : current.outputs[mode]?.poster;
  if (poster) player.poster = mediaUrl(current, poster);
  else player.removeAttribute("poster");
  player.src = url;
  player.load();
  updateScreen();
}
player.addEventListener("loadedmetadata", () => {
  preparingSource = false;
  if (typeof pendingSeek === "number")
    player.currentTime = Math.max(0, Math.min(pendingSeek, player.duration || pendingSeek));
  pendingSeek = undefined;
  if (resumePlayback) player.play().catch(() => {});
  resumePlayback = false;
  if (current?.outputs[mode]) updateScreen();
});
player.addEventListener("error", () => {
  if (visible !== "work" || !current?.outputs[mode] || !player.error || !player.getAttribute("src")) return;
  if (playerAsset === mediaUrl(current, "source") && [3, 4].includes(player.error.code)) {
    const at = pendingSeek ?? player.currentTime ?? 0;
    const play = resumePlayback || auditionEnd !== null || !player.paused;
    compatibleSources.add(current.id);
    selectPlayer("source", at, play);
    return;
  }
  preparingSource = false;
  endAudition();
  updateScreen();
  toast(
    playerView === "output"
      ? "미리보기를 재생할 수 없어요. MP4 저장으로 파일을 확인해 주세요."
      : "이 구간을 재생할 수 없어요. 잠시 뒤 구간을 다시 선택해 주세요.",
  );
});
function positionInSource(timeline, outputTime) {
  const part = timeline.find((span) => span.end > outputTime) || timeline.at(-1);
  return part ? part.source + (part.intro ? 0 : Math.max(0, outputTime - part.at)) : 0;
}
function positionInOutput(timeline, sourceTime) {
  const span = timeline.find(
    (s) => !s.intro && sourceTime >= s.source && sourceTime < s.source + s.end - s.at,
  );
  if (span) return span.at + sourceTime - span.source;
  return (timeline.find((s) => !s.intro && s.source >= sourceTime) || timeline.at(-1))?.at || 0;
}
let auditionEnd = null;
let captionListening = false;
let frameRequest;
let imageURL;
let imageTime = null;
let videoCallback;
let reviewSession = null;

function endAudition() {
  const wasReview = Boolean(reviewSession);
  reviewSession = null;
  resumePlayback = false;
  $("stop-review").hidden = true;
  auditionEnd = null;
  captionListening = false;
  $("audition-caption").hidden = true;
  if (videoCallback != null && player.cancelVideoFrameCallback)
    player.cancelVideoFrameCallback(videoCallback);
  videoCallback = null;
  if (wasReview && current?.outputs[mode]) updateScreen();
}
$("stop-review").onclick = () => {
  player.pause();
  endAudition();
};
player.addEventListener("ended", endAudition);
function closeFrame() {
  frameRequest?.abort();
  frameRequest = null;
  $("draft-frame").hidden = true;
  $("draft-frame").removeAttribute("src");
  if (imageURL) URL.revokeObjectURL(imageURL);
  imageURL = null;
  imageTime = null;
  if (current?.outputs[mode]) updateScreen();
}
function sourceTime() {
  if (imageTime !== null) return imageTime;
  const at = Number.isFinite(pendingSeek) ? pendingSeek : player.currentTime || 0;
  return playerView === "output" ? positionInSource(current?.outputs[mode]?.timeline || [], at) : at;
}
function updateScreen() {
  const output = current.outputs[mode];
  const original = playerView === "source" && imageTime === null;
  const cropSource = playerView === "crop" && imageTime === null;
  const vertical = mode !== "main" && !original;
  $("screen").classList.toggle("vertical", vertical);
  $("screen").classList.toggle("crop-source", cropSource);
  $("compare").setAttribute("aria-pressed", String(original));
  text(
    "compare",
    imageTime !== null || original ? "저장된 영상 보기" : mode === "crop" ? "원본 전체 보기" : "원본 보기",
  );
  text(
    "dimensions",
    imageTime !== null
      ? "스타일 미리보기 · 원본 " + precise(imageTime)
      : preparingSource
        ? "이 브라우저에서 재생할 편집용 영상을 준비하고 있어요…"
        : reviewSession
          ? reviewSession.label + (playerView === "output" ? " · 저장본" : " · 원본 컷 미리보기")
          : cropSource
            ? "9:16 크롭 · 원본 구간"
            : original
              ? "원본 영상"
              : output.width + " × " + output.height + " · MP4",
  );
}
function showPlayer(at, play = false) {
  closeFrame();
  endAudition();
  const output = current.outputs[mode];
  updateScreen();
  selectPlayer(playerView === "output" ? output.file : "source", at, play);
}
function seekSource(at) {
  player.pause();
  playerView = mode === "crop" ? "crop" : "source";
  showPlayer(Math.max(0, at));
  inspector.tick(at);
}
function showMonitor() {
  if (matchMedia("(max-width: 900px)").matches)
    $("screen").scrollIntoView({ block: "center", behavior: "instant" });
}
$("return-to-tools").onclick = () => document.querySelector("[data-tool][aria-pressed=true]").focus();
function captionTick(at = player.currentTime) {
  const overlay = $("audition-caption");
  if (!captionListening || playerView === "output") {
    overlay.hidden = true;
    return;
  }
  const words = inspector.activeCaption(at);
  const face = { gothic: "Malgun Gothic", serif: "Batang", round: "Gulim" }[inspector.draft.font];
  overlay.style.fontFamily = '"' + face + '", sans-serif';
  overlay.style.fontWeight = inspector.draft.font === "gothic" ? "bold" : "normal";
  overlay.textContent = words;
  overlay.hidden = !words;
}
function checkAudition(at) {
  if (auditionEnd === null || player.seeking || pendingSeek !== undefined) return;
  if (at >= auditionEnd) {
    if (reviewSession && reviewSession.index + 1 < reviewSession.parts.length) {
      const next = reviewSession.parts[++reviewSession.index];
      auditionEnd = next.end;
      player.currentTime = next.start;
      $("audition-caption").hidden = true;
      return;
    }
    player.pause();
    endAudition();
    return;
  }
  captionTick(at);
}
function review(parts, kind, saved) {
  if (saved) {
    const end = current.outputs[mode].duration;
    parts = [{ start: 0, end: kind === "opening" ? Math.min(30, end) : end }];
  }
  const first = parts[0];
  audition(first.start, first.end, !saved, saved ? "output" : "source");
  reviewSession = {
    parts,
    index: 0,
    label: { opening: "첫 30초", join: "이음새 앞뒤", all: "본편 전체" }[kind],
  };
  $("stop-review").hidden = false;
  updateScreen();
}
function audition(a, b, withCaptions = false, view = mode === "crop" ? "crop" : "source") {
  playerView = view;
  showPlayer(a, true);
  auditionEnd = b;
  captionListening = withCaptions;
  showMonitor();
  if (player.requestVideoFrameCallback) {
    const frame = (_, meta) => {
      checkAudition(meta.mediaTime);
      if (auditionEnd !== null) videoCallback = player.requestVideoFrameCallback(frame);
    };
    videoCallback = player.requestVideoFrameCallback(frame);
  }
}
async function preview(payload, at) {
  const job = current,
    kind = mode;
  if (!job || kind !== payload.mode) return;
  at = Math.max(0, Math.min(at, job.info.duration - 0.1));
  frameRequest?.abort();
  const controller = new AbortController();
  frameRequest = controller;
  player.pause();
  endAudition();
  inspector.feedback("스타일 미리보기를 만드는 중…");
  try {
    const result = await fetch("/api/jobs/" + job.id + "/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, at }),
      signal: controller.signal,
    });
    if (!result.ok) {
      const err = await result.json();
      throw new Error(typeof err.detail === "string" ? err.detail : "미리보기를 만들 수 없어요.");
    }
    const blob = await result.blob();
    if (controller.signal.aborted || job.id !== current?.id || kind !== mode || inspector.tab !== "style")
      return;
    if (imageURL) URL.revokeObjectURL(imageURL);
    imageURL = URL.createObjectURL(blob);
    imageTime = at;
    $("draft-frame").src = imageURL;
    $("draft-frame").hidden = false;
    updateScreen();
    inspector.feedback("");
  } catch (e) {
    if (!controller.signal.aborted) inspector.feedback(e.message);
  }
}
$("compare").addEventListener("click", () => {
  const at = sourceTime();
  const play = imageTime === null && !player.paused;
  playerView = imageTime !== null || playerView === "source" ? "output" : "source";
  showPlayer(playerView === "source" ? at : positionInOutput(current.outputs[mode].timeline, at), play);
});
function paintTimeline(output) {
  const group = $("timeline");
  text("timeline-heading", "저장된 편집본");
  group.setAttribute("aria-label", "편집본 구간 재생");
  if (mode === "main") return;
  group.replaceChildren();
  for (const span of output.timeline) {
    const strip = node("button", "strip");
    strip.type = "button";
    strip.style.flexGrow = String(Math.max(0.3, span.end - span.at));
    strip.style.flexBasis = "0";
    const label = span.intro ? "도입 내레이션" : "원본 " + time(span.source);
    strip.title = label;
    strip.setAttribute("aria-label", label + " 재생");
    strip.dataset.at = String(span.at);
    strip.dataset.end = String(span.end);
    strip.addEventListener("click", () => {
      playerView = "output";
      showPlayer(span.at, true);
    });
    group.append(strip);
  }
  text("timeline-time", time(output.duration));
}
player.addEventListener("timeupdate", () => {
  if (!current?.outputs[mode]) return;
  if (!player.requestVideoFrameCallback) checkAudition(player.currentTime);
  const sourceAt = sourceTime();
  inspector.tick(sourceAt);
  const at =
    mode === "main"
      ? sourceAt
      : playerView === "output"
        ? player.currentTime
        : positionInOutput(current.outputs[mode].timeline, player.currentTime);
  for (const strip of $("timeline").children)
    strip.classList.toggle("active", at >= Number(strip.dataset.at) && at < Number(strip.dataset.end));
});
function paintEditor() {
  const output = current.outputs[mode];
  document.querySelectorAll("[data-mode]").forEach((button) => {
    const key = button.dataset.mode;
    button.disabled = !current.outputs[key];
    button.setAttribute("aria-pressed", String(key === mode));
    text(key + "-time", current.outputs[key] ? time(current.outputs[key].duration) : "");
  });
  $("download").href = mediaUrl(current, output.file) + "?download=true";
  $("srt").hidden = !output.srt;
  if (output.srt) $("srt").href = mediaUrl(current, output.srt) + "?download=true";
  const added = output.settings.addedCaptions?.length || 0;
  const sourceLabel = current.captionCount ? "원본 자막 " + current.captionCount + "개" : "";
  text(
    "caption-origin",
    [current.method, sourceLabel, added ? "직접 추가 " + added + "개" : ""].filter(Boolean).join(" · "),
  );
  if (playerAsset !== playbackUrl(current, playerView === "output" ? output.file : "source"))
    showPlayer(playerView === "output" ? 0 : output.timeline[0]?.source || 0);
  paintTimeline(output);
  inspector.open(current, mode, config);
}
function setMode(next) {
  if (!current?.outputs[next]) return;
  closeFrame();
  endAudition();
  mode = next;
  history.replaceState(history.state, "", "#job/" + current.id + (mode === "main" ? "" : "/" + mode));
  playerView = "output";
  editorSignature = "";
  paintJob();
}
document
  .querySelectorAll("[data-mode]")
  .forEach((button) => (button.onclick = () => setMode(button.dataset.mode)));
async function saveEdits(payload) {
  if (revisionPending) return;
  const jobId = current.id,
    token = routeVersion;
  revisionPending = true;
  inspector.busy = true;
  inspector.paintRows();
  inspector.paintSettings();
  inspector.status();
  try {
    const job = await api("/api/jobs/" + jobId + "/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (token !== routeVersion) return;
    closeFrame();
    endAudition();
    current = job;
    playerView = "output";
    editorSignature = "";
    paintJob();
    clearTimeout(timer);
    timer = setTimeout(() => poll(jobId, token), 450);
  } catch (e) {
    toast(e.message);
  } finally {
    revisionPending = false;
    inspector.busy = false;
    if (current?.id === jobId && visible === "work" && current.outputs[mode])
      inspector.open(current, mode, config);
  }
}
const inspector = new Inspector({
  setMode,
  sourceTime,
  seek: seekSource,
  audition,
  review,
  preview,
  closeFrame,
  showMonitor,
  stopAudition: () => {
    if (auditionEnd !== null) {
      player.pause();
      endAudition();
    }
  },
  captionChanged: () => captionTick(),
  captions: (id) => api("/api/jobs/" + id + "/captions"),
  recommendations: (id) => api("/api/jobs/" + id + "/recommendations"),
  save: saveEdits,
  isHidden: () => visible !== "work",
});
for (const id of ["download", "srt"]) {
  $(id).addEventListener("click", (event) => {
    if ($(id).getAttribute("aria-disabled") === "true") {
      event.preventDefault();
      toast("변경 저장을 마치면 다운로드할 수 있어요.");
    }
  });
}
$("retry").onclick = async () => {
  try {
    const id = current.id;
    await api("/api/jobs/" + id + "/retry", { method: "POST" });
    await refresh();
  } catch (e) {
    toast(e.message);
  }
};
function setCaption(file) {
  inputCaption = file;
  text("attach", file ? file.name : "자막 파일 첨부");
  $("unset-caption").hidden = !file;
  text("speech-info", file ? "첨부 자막" : config.speech ? "한국어 자동 자막" : "SRT / VTT 자막");
}
function uploadFiles(list) {
  const files = Array.from(list);
  const captions = files.filter((f) => /\.(srt|vtt)$/i.test(f.name));
  const videos = files.filter((f) => /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name));
  if (videos.length > 1 || captions.length > 1) {
    toast("영상 한 편과 선택 자막 한 개를 함께 올려주세요.");
    return;
  }
  if (captions.length) setCaption(captions[0]);
  if (videos.length) startUpload(videos[0]);
  else if (!captions.length) toast("지원하는 영상 또는 자막 파일을 선택해 주세요.");
}
function startUpload(file) {
  if (uploading) return;
  uploading = true;
  current = null;
  clearTimeout(timer);
  ++routeVersion;
  location.hash = "upload";
  show("work");
  $("editor").hidden = true;
  $("retry-box").hidden = true;
  $("progress-area").hidden = false;
  text("job-name", stem(file.name));
  text("job-meta", "원본 영상");
  text("job-stage", "업로드 중");
  text("progress-title", "원본 업로드");
  text("percent", "0%");
  $("progress").value = 0;
  text("progress-detail", "이 PC의 편집 작업 공간에 영상을 저장하고 있어요.");
  const form = new FormData();
  form.append("video", file, file.name);
  if (inputCaption) form.append("captions", inputCaption, inputCaption.name);
  const req = new XMLHttpRequest();
  req.open("POST", "/api/jobs");
  req.responseType = "json";
  req.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const percent = Math.round((e.loaded / e.total) * 100);
      $("progress").value = percent;
      text("percent", percent + "%");
    }
  };
  const fail = (message) => {
    uploading = false;
    toast(message);
    if (location.hash === "#upload") location.hash = "studio";
  };
  req.onerror = () => fail("업로드가 끊겼어요. 로컬 서버 연결을 확인해 주세요.");
  req.onload = () => {
    if (req.status >= 200 && req.status < 300 && req.response?.id) {
      uploading = false;
      setCaption(null);
      if (location.hash === "#upload") location.hash = "job/" + req.response.id;
      else toast("업로드 완료 · 보관함에서 작업을 열 수 있어요.");
    } else
      fail(typeof req.response?.detail === "string" ? req.response.detail : "업로드를 완료하지 못했어요.");
  };
  req.send(form);
}
$("pick").onclick = () => $("file").click();
$("attach").onclick = () => $("caption-file").click();
$("unset-caption").onclick = () => setCaption(null);
$("file").onchange = (e) => {
  uploadFiles(e.target.files);
  e.target.value = "";
};
$("caption-file").onchange = (e) => {
  if (e.target.files[0]) setCaption(e.target.files[0]);
  e.target.value = "";
};
let dragDepth = 0;
const drop = $("drop");
drop.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  drop.classList.add("dragging");
  text("drop-title", "여기에 놓으면 편집을 시작해요");
});
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});
function dragReset() {
  dragDepth = 0;
  drop.classList.remove("dragging");
  text("drop-title", "원본 영상을 놓아주세요");
}
drop.addEventListener("dragleave", (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) dragReset();
});
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  dragReset();
  uploadFiles(e.dataTransfer.files);
});
window.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
$("demo").onclick = async () => {
  const button = $("demo");
  button.disabled = true;
  try {
    const job = await api("/api/demo", { method: "POST" });
    location.hash = "job/" + job.id;
  } catch (e) {
    toast(e.message);
  } finally {
    button.disabled = false;
  }
};
window.addEventListener("hashchange", refresh);
async function boot() {
  try {
    config = await api("/api/config");
    text("speech-info", config.speech ? "한국어 자동 자막" : "SRT / VTT 자막");
    const engine = $("engine");
    engine.className = "engine " + (config.engine ? "online" : "offline");
    engine.replaceChildren(
      node("i"),
      document.createTextNode(config.engine ? "로컬 엔진 연결됨" : "영상 엔진 확인 필요"),
    );
    $("demo").disabled = !config.demo;
    $("pick").disabled = !config.engine;
  } catch {
    const engine = $("engine");
    engine.className = "engine offline";
    engine.replaceChildren(node("i"), document.createTextNode("서버 연결 필요"));
  }
  await refresh();
}
boot();

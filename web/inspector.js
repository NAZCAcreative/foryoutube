import { TrimTrack } from "./trim-track.js";
import { DraftCache } from "./draft-cache.js";
import {
  durationOf,
  frame,
  keptSpans,
  manualPoint,
  omitWindow,
  overlapDuration,
  repeatedLines,
  reviewSpans,
  splitClip,
  suggestedPoints,
  textForPiece,
} from "./cut-plan.js";

const el = (id) => document.getElementById(id);
const defaults = {
  captions: true,
  emphasis: true,
  narration: false,
  transition: true,
  font: "gothic",
  look: "original",
  cropX: 50,
  cropY: 50,
  captionShift: 0,
  ids: [],
  ranges: {},
  custom: [],
  captionEdits: {},
  addedCaptions: [],
};
const fields = Object.keys(defaults);
const round = (value) => Math.round(value * 1000) / 1000;
const bounded = (value, low, high) => Math.max(low, Math.min(value, high));

export function precise(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return (
    Math.floor(ms / 60000) +
    ":" +
    String(Math.floor(ms / 1000) % 60).padStart(2, "0") +
    "." +
    String(ms % 1000).padStart(3, "0")
  );
}

function parseTime(input) {
  const value = input.trim().replace(",", ".");
  if (/^\d+(?:\.\d{1,3})?$/.test(value)) return Number(value);
  const match = /^(\d+):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) + Number("0." + (match[3] || "0")) : NaN;
}

function make(tag, label, className) {
  const node = document.createElement(tag);
  if (label !== undefined) node.textContent = label;
  if (className) node.className = className;
  return node;
}
function button(label, action, css = "quiet") {
  const result = make("button", label, css);
  result.type = "button";
  result.onclick = action;
  return result;
}
function normalized(settings) {
  return Object.fromEntries(fields.map((k) => [k, structuredClone(settings[k] ?? defaults[k])]));
}

export class Inspector {
  constructor(host) {
    this.host = host;
    this.track = new TrimTrack(
      el("trim-wave"),
      precise,
      (kind, key, value) => this.setTime(kind, key, value),
      (at) => this.host.seek(at),
    );
    this.reset();
    this.buildTimes("cut");
    this.buildTimes("cue");
    document.querySelectorAll("[data-tool]").forEach((b) => (b.onclick = () => this.openTab(b.dataset.tool)));
    document.querySelectorAll("[data-setting]").forEach(
      (input) =>
        (input.onchange = () => {
          this.draft[input.dataset.setting] = input.checked;
          this.paintSettings();
          this.status();
          if (this.tab === "style") this.previewSoon();
          if (this.tab === "captions") this.host.captionChanged();
        }),
    );
    el("bulk").onclick = () => {
      this.bulk = !this.bulk;
      this.marked.clear();
      this.paintRows();
    };
    el("select-all").onchange = (e) => {
      this.marked = new Set(e.target.checked ? this.clips().map((c) => c.id) : []);
      this.paintRows();
    };
    el("include").onclick = () => this.setIncluded(this.marked, true);
    el("exclude").onclick = () => this.setIncluded(this.marked, false);
    el("batch-split").onclick = () => this.splitScene(true);
    el("play-cut").onclick = () => this.playCut();
    el("add-cut").onclick = () => this.addCut();
    el("split-now").onclick = () => this.splitHere();
    el("split-clock").onchange = (e) => {
      const at = parseTime(e.target.value);
      if (!Number.isFinite(at) || at < 0 || at > this.duration) {
        e.target.value = precise(this.host.sourceTime());
        this.feedback("원본 범위 안의 시각을 입력하세요.");
        return;
      }
      this.host.seek(at);
    };
    el("split-clock").onkeydown = (e) => {
      if (e.key === "Enter") e.target.blur();
    };
    el("split-auto").onclick = () => this.splitScene(this.bulk && this.marked.size > 0);
    el("split-rule").onchange = () => this.batchState(this.rowClips);
    el("recommendations").ontoggle = () => {
      if (el("recommendations").open && this.job) this.loadRecommendations();
    };
    el("use-recommendations").onclick = () => this.applyRecommendations();
    el("cut-undo").onclick = () => this.undoCut(false);
    el("cut-redo").onclick = () => this.undoCut(true);
    el("omit-spoken").onclick = () => this.removeSpoken();
    el("repeat-cue").onclick = () => this.findRepeat();
    el("repeat-other").onclick = () => {
      const c = this.allCues()[this.repeatPair?.[1]];
      if (c) this.playLine(c);
    };
    for (const kind of ["opening", "join", "all"]) el("review-" + kind).onclick = () => this.review(kind);
    document.addEventListener("keydown", (e) => {
      if (
        !this.job ||
        this.host.isHidden() ||
        this.locked ||
        e.defaultPrevented ||
        e.isComposing ||
        e.repeat ||
        e.altKey ||
        e.target.closest?.("input,textarea,select,[contenteditable=true],[role=slider]")
      )
        return;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && (key === "z" || key === "y")) {
        const redo = key === "y" || e.shiftKey;
        if (this.histories[this.mode]?.[redo ? "redo" : "undo"].length) {
          e.preventDefault();
          this.undoCut(redo);
        }
      } else if (!e.ctrlKey && !e.metaKey && key === "s" && this.tab === "cuts" && this.mode === "main") {
        e.preventDefault();
        this.splitHere();
      }
    });
    el("to-short").onclick = () => this.convert();
    el("cue-select").onchange = (e) => {
      this.cueId = Number(e.target.value);
      this.repeatPair = null;
      this.paintCue();
      this.host.seek(this.cue().start + this.draft.captionShift);
    };
    el("cue-search").oninput = () => this.paintCue();
    el("find-cue").onclick = () => {
      const at = this.host.sourceTime() - this.draft.captionShift;
      let best = Infinity;
      this.allCues().forEach((c, i) => {
        const distance = Math.max(c.start - at, at - c.end, 0);
        if (distance < best) {
          best = distance;
          this.cueId = i;
        }
      });
      el("cue-search").value = "";
      this.paintCue();
    };
    el("cue-text").oninput = (e) => this.editCue({ ...this.cue(), text: e.target.value });
    el("add-cue").onclick = () => this.addCue();
    el("omit-cue").onclick = () => this.omitCue();
    el("play-cue").onclick = () => this.playCue();
    el("shift-earlier").onclick = () => this.shift(this.draft.captionShift - 0.1);
    el("shift-later").onclick = () => this.shift(this.draft.captionShift + 0.1);
    el("caption-shift").onchange = (e) => this.shift(Number(e.target.value));
    el("font").onchange = (e) => this.style("font", e.target.value);
    document
      .querySelectorAll("[data-look]")
      .forEach((b) => (b.onclick = () => this.style("look", b.dataset.look)));
    el("crop-x").oninput = (e) => this.style("cropX", Number(e.target.value));
    el("crop-y").oninput = (e) => this.style("cropY", Number(e.target.value));
    el("crop-center").onclick = () => {
      this.draft.cropX = defaults.cropX;
      this.draft.cropY = defaults.cropY;
      this.paintSettings();
      this.status();
      this.previewSoon(0);
    };
    el("preview-style").onclick = () => {
      this.host.showMonitor();
      this.previewSoon(0, true);
    };
    el("undo").onclick = () => {
      this.draftCaches[this.mode].discard(true);
      delete this.drafts[this.mode];
      this.host.stopAudition();
      this.host.closeFrame();
      this.feedback("");
      this.open(this.job, this.mode, this.config, false);
    };
    el("apply").onclick = () => {
      if (!this.error() && this.changed()) this.host.save(this.payload());
    };
  }
  reset() {
    clearTimeout(this.previewTimer);
    this.track.clear();
    this.track.hide();
    this.job = null;
    this.mode = null;
    this.drafts = {};
    this.draftCaches = {};
    this.histories = {};
    this.repeatPair = null;
    this.anchor = null;
    this.rowClips = [];
    this.active = {};
    this.bulk = false;
    this.marked = new Set();
    this.cues = null;
    this.plans = null;
    this.planRequest = null;
    el("recommendations").open = false;
    this.cueId = 0;
    this.tab = "cuts";
    this.busy = false;
    this.loadingCues = null;
    this.captionCache = null;
    el("cue-search").value = "";
    el("add-cue").disabled = true;
    el("cue-form").hidden = true;
    el("no-cues").hidden = true;
    this.feedback("");
  }
  open(job, mode, config, restore = true) {
    if (this.job?.id !== job.id) this.reset();
    if (this.mode !== mode) {
      this.marked.clear();
      this.bulk = false;
      this.feedback("");
      this.repeatPair = null;
    }
    this.job = job;
    this.mode = mode;
    this.config = config;
    this.captionCache = null;
    const output = job.outputs[mode];
    const revision = output.editRevision || output.file;
    if (!this.drafts[mode] || this.drafts[mode].revision !== revision) {
      this.draftCaches[mode]?.discard();
      const cache = new DraftCache(job.id, mode, revision);
      this.draftCaches[mode] = cache;
      const recovered = restore ? cache.restore() : null;
      this.drafts[mode] = { ...normalized(recovered?.settings ?? output.settings), revision };
      this.histories[mode] = { undo: [], redo: [] };
      if (mode === "main") this.anchor = Number.isFinite(recovered?.anchor) ? recovered.anchor : null;
      if (recovered) {
        this.active[mode] = recovered.active;
        this.feedback("이전에 작업하던 임시 초안을 복구했어요.");
      }
    }
    this.track.load(job);
    const clips = this.clips();
    if (!clips.some((c) => c.id === this.active[mode]))
      this.active[mode] = clips.find((c) => this.draft.ids.includes(c.id))?.id ?? clips[0]?.id;
    this.paintRows();
    this.paintSettings();
    this.openTab(this.tab, false);
    this.status();
  }
  cutSnapshot() {
    const { ids, ranges, custom } = this.draft;
    return {
      data: structuredClone({ ids, ranges, custom }),
      active: this.active[this.mode],
      at: this.host.sourceTime(),
      anchor: this.anchor,
    };
  }
  rememberCut() {
    this.host.stopAudition();
    const h = this.histories[this.mode];
    h.undo.push(this.cutSnapshot());
    if (h.undo.length > 50) h.undo.shift();
    h.redo.length = 0;
  }
  undoCut(redo) {
    const h = this.histories[this.mode],
      stack = h[redo ? "redo" : "undo"];
    if (this.locked || !stack.length) return;
    h[redo ? "undo" : "redo"].push(this.cutSnapshot());
    const previous = stack.pop();
    Object.assign(this.draft, previous.data);
    this.active[this.mode] = previous.active;
    if (this.mode === "main") this.anchor = previous.anchor;
    this.marked.clear();
    this.host.seek(previous.at);
    this.paintRows();
    if (this.tab === "captions") this.paintCue();
    this.status();
    this.feedback(redo ? "컷 수정을 다시 적용했어요." : "직전 컷 수정을 되돌렸어요.");
  }
  clipAt(at) {
    const current = this.rowClips.find((c) => c.id === this.active.main);
    return manualPoint(current, at) !== null
      ? current
      : this.rowClips.find((c) => this.draft.ids.includes(c.id) && manualPoint(c, at) !== null);
  }
  tick(at) {
    this.track.tick(at);
    if (this.mode !== "main" || this.tab !== "cuts") return;
    if (document.activeElement !== el("split-clock")) el("split-clock").value = precise(at);
    el("split-clock").disabled = this.locked;
    el("split-now").disabled = this.locked || !this.clipAt(at);
  }
  splitHere() {
    const at = this.host.sourceTime(),
      clip = this.clipAt(at);
    if (!clip) {
      this.feedback("파형이나 재생 막대에서 장면 안쪽의 분할 위치를 골라 주세요.");
      return;
    }
    const point = manualPoint(clip, at);
    this.rememberCut();
    const pieces = splitClip(this.draft, clip, [point], this.cutCues());
    this.active.main = pieces[1];
    this.anchor = point;
    this.host.seek(point);
    this.paintRows();
    this.status();
    this.feedback(precise(point) + "에서 두 조각으로 나눴어요.");
  }
  async splitScene(batch = false) {
    const draft = this.draft,
      ids = batch ? new Set(this.marked) : new Set([this.active.main]),
      rule = el("split-rule").value;
    if (!ids.size || this.locked || this.mode !== "main") return;
    if (rule === "speech") await this.loadCues();
    if (
      this.draft !== draft ||
      this.mode !== "main" ||
      this.tab !== "cuts" ||
      (batch
        ? !this.bulk || this.marked.size !== ids.size || [...ids].some((id) => !this.marked.has(id))
        : !ids.has(this.active.main)) ||
      this.locked ||
      this.host.isHidden()
    )
      return;
    if (rule === "speech" && this.job.captionCount && !this.cues) {
      this.feedback("대사 시각을 불러오지 못했어요. 다시 누르거나 시간 간격을 골라 주세요.");
      return;
    }
    const cues = this.cutCues();
    const targets = this.clips()
      .filter((clip) => ids.has(clip.id))
      .map((clip) => ({ clip, points: suggestedPoints(clip, cues, rule) }))
      .filter(({ points }) => points.length);
    if (!targets.length) {
      this.feedback(
        rule === "speech"
          ? "선택 안에 더 나눌 대사 경계가 없어요. 재생 위치나 시간 간격으로 나눌 수 있어요."
          : "선택한 간격으로 나눌 만큼 긴 장면이 없어요.",
      );
      return;
    }
    this.rememberCut();
    let pieces = 0;
    for (const { clip, points } of targets) pieces += splitClip(draft, clip, points, cues).length;
    this.active.main = targets[0].clip.id;
    this.anchor = targets[0].points[0];
    this.marked.clear();
    this.paintRows();
    this.status();
    const fallback =
      rule === "speech" &&
      !targets.some(({ clip }) => cues.some((c) => c.start < clip.end && c.end > clip.start));
    this.feedback(
      targets.length +
        "개 장면을 " +
        (fallback ? "대사 없이 5초 간격으로 " : "") +
        pieces +
        "조각으로 나눴어요. 덜어낼 조각 옆의 ‘빼기’를 누르세요.",
    );
  }
  get draft() {
    return this.drafts[this.mode];
  }
  get duration() {
    return this.job.info.duration;
  }
  get locked() {
    return this.busy || this.job.status !== "ready";
  }
  get base() {
    return this.job.clips[this.mode === "main" ? "main" : "short"] || [];
  }
  clips() {
    return [...this.base, ...this.draft.custom]
      .map((c) => ({ ...c, ...this.draft.ranges[c.id] }))
      .sort((a, b) => a.start - b.start);
  }
  clip() {
    return this.clips().find((c) => c.id === this.active[this.mode]);
  }
  cue() {
    if (this.cueId >= this.job.captionCount)
      return this.draft.addedCaptions[this.cueId - this.job.captionCount];
    return this.draft.captionEdits[this.cueId] ?? this.cues?.[this.cueId];
  }
  allCues() {
    return [...(this.cues || []).map((c, i) => this.draft.captionEdits[i] ?? c), ...this.draft.addedCaptions];
  }
  cutCues() {
    const shift = this.draft.captionShift;
    const cues = this.allCues();
    if (!shift) return cues;
    return cues
      .map((c) => ({
        ...c,
        start: Math.max(0, c.start + shift),
        end: Math.min(this.duration, c.end + shift),
      }))
      .filter((c) => c.start < c.end);
  }
  get hasCaptions() {
    return Boolean(this.job.captionCount || this.draft.addedCaptions.length);
  }
  payload() {
    return { ...normalized(this.draft), mode: this.mode, baseRevision: this.draft.revision };
  }
  changed() {
    return (
      JSON.stringify(normalized(this.draft)) !==
      JSON.stringify(normalized(this.job.outputs[this.mode].settings))
    );
  }
  feedback(msg) {
    el("edit-feedback").textContent = msg;
  }
  openTab(tab, explicit = true) {
    if (explicit && this.tab !== tab) {
      this.feedback("");
      this.host.closeFrame();
      this.host.stopAudition();
    }
    this.tab = tab;
    document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== tab));
    document
      .querySelectorAll("[data-tool]")
      .forEach((b) => b.setAttribute("aria-pressed", b.dataset.tool === tab));
    if (tab === "cuts") {
      if (explicit && this.mode === "main") this.paintRows();
      else {
        this.paintTimes("cut", this.clip());
        this.tick(this.host.sourceTime());
      }
      if (this.mode === "main" && this.job.captionCount && !this.cues) this.loadCues();
    } else this.track.hide();
    if (tab === "captions") this.loadCues();
    if (tab === "style" && explicit) this.previewSoon(0);
  }
  async loadCues() {
    const job = this.job;
    if (!job.captionCount) this.cues = [];
    if (this.cues?.length === job.captionCount) {
      if (this.tab === "captions") this.paintCue();
      return;
    }
    if (this.loadingCues) return this.loadingCues;
    el("add-cue").disabled = true;
    const pending = this.host
      .captions(job.id)
      .then((data) => {
        if (this.job?.id !== job.id) return;
        this.cues = data.cues;
        const at = this.host.sourceTime();
        const found = this.cues.findIndex((c) => c.end > at);
        this.cueId = found < 0 ? Math.max(0, this.cues.length - 1) : found;
        if (this.tab === "captions") this.paintCue();
        if (this.tab === "cuts" && (this.draft.custom.length || Object.keys(this.draft.ranges).length))
          this.paintRows();
      })
      .catch((e) => {
        if (this.job?.id === job.id) this.feedback(e.message);
      });
    this.loadingCues = pending;
    await pending;
    if (this.loadingCues === pending) this.loadingCues = null;
  }
  paintRows() {
    const rows = el("clips");
    const selectedBefore = rows.querySelector(".cut-row.current .cut-select")?.dataset.focus;
    const focusKey = rows.contains(document.activeElement) ? document.activeElement.dataset.focus : "";
    const scroll = rows.scrollTop;
    rows.replaceChildren();
    el("bulk").setAttribute("aria-pressed", String(this.bulk));
    el("batch-bar").hidden = !this.bulk;
    const clips = this.clips();
    const cues = this.cutCues();
    this.rowClips = clips;
    for (const clip of clips) {
      if (this.draft.ranges[clip.id] || clip.id.startsWith("custom-")) clip.title = textForPiece(clip, cues);
      const included = this.draft.ids.includes(clip.id);
      const row = make("div", undefined, "cut-row");
      row.dataset.included = String(included);
      row.classList.toggle("current", clip.id === this.active[this.mode]);
      if (this.bulk) {
        const check = make("input");
        check.type = "checkbox";
        check.dataset.focus = "mark-" + clip.id;
        check.checked = this.marked.has(clip.id);
        check.disabled = this.locked;
        check.setAttribute("aria-label", precise(clip.start) + " 일괄 선택");
        check.onchange = () => {
          if (check.checked) this.marked.add(clip.id);
          else this.marked.delete(clip.id);
          this.batchState(clips);
        };
        row.append(check);
      }
      const select = button(
        "",
        () => {
          this.active[this.mode] = clip.id;
          this.host.seek(clip.start);
          this.paintRows();
          this.feedback("");
        },
        "cut-select",
      );
      select.setAttribute("aria-pressed", String(clip.id === this.active[this.mode]));
      select.dataset.focus = "select-" + clip.id;
      select.append(
        make("strong", clip.title),
        make("small", (included ? "" : "제외됨 · ") + precise(clip.start) + " – " + precise(clip.end)),
      );
      const toggle = button(
        included ? "빼기" : "넣기",
        () => this.setIncluded(new Set([clip.id]), !included),
        "cut-toggle",
      );
      toggle.dataset.focus = "include-" + clip.id;
      toggle.setAttribute("aria-label", clip.title + (included ? " · 편집본에서 빼기" : " · 편집본에 넣기"));
      toggle.disabled = this.locked;
      row.append(select, toggle);
      rows.append(row);
    }
    if (focusKey)
      rows.querySelector('[data-focus="' + CSS.escape(focusKey) + '"]')?.focus({ preventScroll: true });
    rows.scrollTop = scroll;
    const selectedChanged = selectedBefore !== "select-" + this.active[this.mode];
    if (selectedChanged && rows.clientHeight) {
      const selected = rows.querySelector(".cut-row.current")?.getBoundingClientRect();
      const viewport = rows.getBoundingClientRect();
      if (selected?.top < viewport.top) rows.scrollTop += selected.top - viewport.top;
      else if (selected?.bottom > viewport.bottom) rows.scrollTop += selected.bottom - viewport.bottom;
    }
    this.batchState(clips);
    this.paintTimes("cut", this.clip());
    el("add-cut").disabled = this.locked;
    el("to-short").hidden = this.mode !== "main";
    el("to-short").disabled = this.locked || !this.job.outputs.crop;
    const cut = this.clip();
    el("cut-length").textContent = cut ? "선택 구간 " + round(cut.end - cut.start) + "초" : "";
    const suggested = cut && this.recommended().find((c) => c.start === cut.start && c.end === cut.end);
    const reason = suggested?.reason || (cut && !this.draft.ranges[cut.id] && cut.reason);
    el("cut-reason").hidden = !reason;
    el("cut-reason").textContent = reason ? (suggested || cut.included ? "추천 이유 · " : "") + reason : "";
    const isMain = this.mode === "main";
    for (const id of ["split-tools", "draft-review", "spoken-edit"]) el(id).hidden = !isMain;
    el("cut-history").hidden = false;
    el("cuts-help").textContent = isMain
      ? "장면을 고른 뒤 파형을 눌러 나눌 위치를 정하세요. 덜어낼 조각은 ‘빼기’를 누르세요."
      : "장면을 누르면 원본에서 시작과 끝을 조절할 수 있어요.";
    el("split-auto").disabled = el("split-rule").disabled = this.locked || !cut;
    if (isMain) this.paintDraftTimeline(clips, selectedChanged);
    if (el("recommendations").open && this.plans) this.paintRecommendations();
    this.tick(this.host.sourceTime());
  }
  async loadRecommendations() {
    if (this.plans) return this.paintRecommendations();
    if (this.planRequest) return;
    const id = this.job.id;
    el("recommend-list").replaceChildren();
    el("recommend-status").textContent = "원본의 대사와 장면을 확인하고 있어요…";
    el("use-recommendations").disabled = true;
    const request = this.host.recommendations(id);
    this.planRequest = request;
    try {
      const result = await request;
      if (this.planRequest !== request || this.job?.id !== id) return;
      this.plans = result;
      if (el("recommendations").open) this.paintRecommendations();
    } catch (e) {
      if (this.planRequest === request)
        el("recommend-status").textContent = e.message + " 접었다가 다시 열어 주세요.";
    } finally {
      if (this.planRequest === request) this.planRequest = null;
    }
  }
  recommended() {
    return this.plans?.[this.mode === "main" ? "main" : "short"] ?? [];
  }
  paintRecommendations() {
    const plan = this.recommended();
    const group = el("recommend-list");
    group.replaceChildren();
    for (const c of plan) {
      const listen = button(
        "",
        () => {
          if (this.draft.captions && !this.cues) this.loadCues();
          this.host.audition(c.start, c.end, true);
        },
        "cut-select",
      );
      listen.append(
        make("strong", c.title),
        make("small", precise(c.start) + " – " + precise(c.end) + " · " + c.reason),
      );
      listen.setAttribute("aria-label", c.title + " 추천 구간 재생");
      const item = make("li");
      item.append(listen);
      group.append(item);
    }
    const spans = keptSpans(
      plan,
      plan.map((c) => c.id),
    );
    const current = keptSpans(this.rowClips, this.draft.ids);
    const same = JSON.stringify(spans) === JSON.stringify(current);
    const proposedTime = spans.reduce((sum, part) => sum + part.end - part.start, 0);
    const matched = proposedTime ? Math.round((100 * overlapDuration(spans, current)) / proposedTime) : 0;
    el("use-recommendations").disabled = !plan.length || this.locked || same;
    el("recommend-status").textContent =
      plan.length +
      "개 장면 · " +
      precise(durationOf(spans)).slice(0, -4) +
      (same ? " · 현재 초안과 같은 구간이에요." : " · 추천 시간의 " + matched + "%가 현재 초안에 포함돼요.");
  }
  applyRecommendations() {
    const plan = this.recommended();
    if (this.locked || !plan.length || el("use-recommendations").disabled) return;
    this.rememberCut();
    const pool = this.clips();
    this.draft.ids = plan.map((c) => {
      const existing = pool.find((p) => p.start === c.start && p.end === c.end);
      if (existing) return existing.id;
      const clip = { id: "custom-" + crypto.randomUUID(), start: c.start, end: c.end, title: c.title };
      this.draft.custom.push(clip);
      return clip.id;
    });
    this.active[this.mode] = this.draft.ids[0];
    if (this.mode === "main") this.anchor = null;
    this.marked.clear();
    this.host.seek(plan[0].start);
    this.paintRows();
    this.status();
    this.feedback("추천 구간을 초안에 적용했어요. 편집을 마치면 ‘변경 저장’을 누르세요.");
  }
  paintDraftTimeline(clips, selectedChanged) {
    const group = el("timeline");
    const scroll = group.scrollLeft;
    group.replaceChildren();
    const ids = new Set(this.draft.ids);
    let coveredTo = 0;
    for (const clip of clips) {
      if (!ids.has(clip.id)) continue;
      const start = Math.max(coveredTo, clip.start),
        end = clip.end;
      if (end <= start) continue;
      coveredTo = end;
      const strip = button(
        "",
        (event) => {
          const box = strip.getBoundingClientRect();
          const fraction = event.detail
            ? bounded((event.clientX - box.left) / Math.max(1, box.width), 0, 1)
            : 0;
          this.active.main = clip.id;
          this.openTab("cuts");
          this.host.seek(start + (end - start) * fraction);
          this.paintRows();
          el("timeline")
            .querySelector('[data-piece="' + CSS.escape(clip.id) + '"]')
            ?.focus({ preventScroll: true });
        },
        "strip",
      );
      strip.title = clip.title + " · " + precise(start) + " – " + precise(end);
      strip.setAttribute("aria-label", strip.title);
      strip.setAttribute("aria-pressed", String(this.active.main === clip.id));
      strip.dataset.piece = clip.id;
      strip.dataset.at = String(start);
      strip.dataset.end = String(end);
      strip.style.flexGrow = String(end - start);
      strip.style.flexBasis = "0";
      group.append(strip);
    }
    group.scrollLeft = scroll;
    if (selectedChanged && group.clientWidth) {
      const selected = group.querySelector('[aria-pressed="true"]')?.getBoundingClientRect();
      const viewport = group.getBoundingClientRect();
      if (selected?.left < viewport.left) group.scrollLeft += selected.left - viewport.left;
      else if (selected?.right > viewport.right) group.scrollLeft += selected.right - viewport.right;
    }
    const spans = keptSpans(clips, ids),
      total = durationOf(spans);
    const saved = this.job.outputs.main.timeline
      .filter((c) => !c.intro)
      .reduce((t, c) => t + c.end - c.at, 0);
    const difference = Math.round((total - saved) * 10) / 10;
    el("timeline-time").textContent =
      precise(total).slice(0, -2) +
      (difference ? " · " + Math.abs(difference) + "초 " + (difference < 0 ? "단축" : "추가") : "");
    el("timeline-heading").textContent = "본편 컷 타임라인";
    group.setAttribute("aria-label", "포함한 조각의 분할 위치 선택");
    el("review-join").disabled = spans.length < 2;
    el("review-all").disabled = el("review-opening").disabled = spans.length === 0;
    el("review-join").title =
      spans.length < 2 ? "중간 구간을 빼면 양쪽 연결을 들어볼 수 있어요." : "가까운 이음새의 앞뒤 2초씩 재생";
  }
  review(kind) {
    const spans = keptSpans(this.clips(), this.draft.ids);
    const parts = reviewSpans(spans, kind, this.anchor ?? this.host.sourceTime());
    if (!parts.length) return;
    const saved = kind !== "join" && !this.changed();
    if (!saved && this.draft.captions && !this.cues) this.loadCues();
    this.host.review(parts, kind, saved);
  }
  batchState(clips) {
    el("select-all").checked = clips.length > 0 && this.marked.size === clips.length;
    el("select-all").indeterminate = this.marked.size > 0 && this.marked.size < clips.length;
    el("select-all").disabled = this.locked;
    const count = this.marked.size;
    const rule = el("split-rule").selectedOptions[0].textContent;
    el("batch-split").hidden = this.mode !== "main";
    el("batch-split").disabled = this.locked || !count;
    el("batch-split").textContent = count ? count + "개 나누기" : "선택 나누기";
    el("batch-split").title = rule + " 기준으로 선택한 장면 나누기";
    el("split-auto").textContent = this.bulk && count ? count + "개 장면 나누기" : "선택 장면 나누기";
    el("include").disabled = this.locked || ![...this.marked].some((id) => !this.draft.ids.includes(id));
    el("exclude").disabled = this.locked || ![...this.marked].some((id) => this.draft.ids.includes(id));
  }
  setIncluded(ids, on) {
    if (this.locked || ![...ids].some((id) => this.draft.ids.includes(id) !== on)) return;
    this.rememberCut();
    const clips = this.clips();
    const touched = clips.find((c) => ids.has(c.id) && this.draft.ids.includes(c.id) !== on);
    if (touched && this.mode === "main") this.anchor = (touched.start + touched.end) / 2;
    if (this.mode === "main" && !on) {
      const windows = keptSpans(
        clips,
        [...ids].filter((id) => this.draft.ids.includes(id)),
      );
      const cues = this.cutCues();
      for (const { start, end } of windows) omitWindow(this.draft, this.clips(), start, end, cues);
    }
    const included = new Set(this.draft.ids);
    for (const id of ids) {
      if (on) included.add(id);
      else included.delete(id);
    }
    this.draft.ids = this.clips()
      .filter((c) => included.has(c.id))
      .map((c) => c.id);
    this.marked.clear();
    this.paintRows();
    this.status();
  }
  buildTimes(kind) {
    const group = el(kind + "-times");
    for (const key of ["start", "end"]) {
      const box = make("div", undefined, "time-field"),
        id = kind + "-" + key;
      const label = make("label", key === "start" ? "시작" : "끝");
      label.htmlFor = id;
      const input = make("input");
      input.type = "text";
      input.id = id;
      input.spellcheck = false;
      input.inputMode = "text";
      input.setAttribute(
        "aria-label",
        (kind === "cut" ? "장면 " : "자막 ") + label.textContent + " 시각, 분:초 또는 초",
      );
      input.onchange = () => this.setTime(kind, key, parseTime(input.value));
      input.onkeydown = (e) => {
        if (e.key === "Enter") input.blur();
      };
      const buttons = make("div", undefined, "nudge");
      for (const delta of [-0.1, 0.1]) {
        const b = button(delta < 0 ? "−0.1초" : "+0.1초", () => {
          const item = kind === "cut" ? this.clip() : this.cue();
          this.setTime(kind, key, round(item[key] + (kind === "cue" ? this.draft.captionShift : 0) + delta));
        });
        b.setAttribute("aria-label", label.textContent + (delta < 0 ? " 0.1초 앞당기기" : " 0.1초 늦추기"));
        buttons.append(b);
      }
      const fromPlayer = button(
        "현재 위치",
        () => this.setTime(kind, key, round(this.host.sourceTime())),
        "text-button",
      );
      fromPlayer.setAttribute("aria-label", "재생 위치를 " + label.textContent + "으로 설정");
      buttons.append(fromPlayer);
      box.append(label, input, buttons);
      group.append(box);
    }
  }
  paintTimes(kind, item) {
    if (!item) return;
    const shift = kind === "cue" ? this.draft.captionShift : 0;
    const a = bounded(item.start + shift, 0, this.duration),
      b = bounded(item.end + shift, 0, this.duration);
    el(kind + "-start").value = precise(a);
    el(kind + "-end").value = precise(b);
    el(kind + "-times")
      .querySelectorAll("input,button")
      .forEach((control) => (control.disabled = this.locked));
    if (this.tab === (kind === "cut" ? "cuts" : "captions")) {
      if (b > a) this.track.display(kind, a, b, this.duration, this.host.sourceTime(), this.locked);
      else this.track.hide();
    }
  }
  setTime(kind, key, value) {
    const item = kind === "cut" ? this.clip() : this.cue();
    if (!item) return;
    const shift = kind === "cue" ? this.draft.captionShift : 0;
    const fixed = Math.min(this.duration, value) - shift;
    const range = { start: item.start, end: item.end, [key]: fixed };
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      value > this.duration + 0.001 ||
      fixed < 0 ||
      fixed > this.duration + 0.001 ||
      range.end - range.start < Math.min(1 / 24, this.duration) - 0.001
    ) {
      this.feedback("원본 안의 시각을 분:초.밀리초 또는 초로 입력하세요. 끝은 시작보다 뒤여야 해요.");
      this.paintTimes(kind, item);
      return;
    }
    this.feedback("");
    if (kind === "cut") {
      if (item[key] === fixed) return;
      this.rememberCut();
      if (this.mode === "main") this.anchor = value;
      this.draft.ranges[item.id] = range;
      this.paintRows();
    } else {
      this.editCue({ ...item, ...range });
      this.paintTimes("cue", this.cue());
    }
    this.host.seek(bounded(value, 0, this.duration));
    this.track.tick(value);
    this.status();
  }
  addCut() {
    this.rememberCut();
    const a = bounded(this.host.sourceTime(), 0, Math.max(0, this.duration - 0.5));
    const cut = {
      id: "custom-" + crypto.randomUUID(),
      title: "직접 추가한 장면",
      start: round(a),
      end: Math.min(this.duration, round(a + 5)),
    };
    this.draft.custom.push(cut);
    this.draft.ids.push(cut.id);
    this.active[this.mode] = cut.id;
    this.paintRows();
    this.status();
    this.host.seek(a);
  }
  playCut() {
    const c = this.clip();
    if (c) this.host.audition(c.start, c.end);
  }
  convert() {
    const cut = this.clip();
    if (!cut) return;
    const settings = normalized(this.draft);
    this.host.setMode("crop");
    this.rememberCut();
    const max = settings.narration ? 55 : 60;
    const added = {
      id: "custom-" + crypto.randomUUID(),
      title: cut.title,
      start: cut.start,
      end: Math.min(cut.end, round(cut.start + max)),
    };
    const out = this.draft;
    Object.assign(out, settings, {
      cropX: defaults.cropX,
      cropY: defaults.cropY,
      ranges: {},
      custom: [added],
      ids: [added.id],
    });
    this.active.crop = added.id;
    this.openTab("cuts");
    this.paintRows();
    this.paintSettings();
    this.status();
    this.feedback(
      cut.end > added.end
        ? "쇼츠 길이에 맞춰 앞부분을 선택했어요. 시작과 끝을 조절한 뒤 저장하세요."
        : "이 장면을 크롭 쇼츠로 준비했어요. 변경 저장을 누르면 영상이 만들어져요.",
    );
    this.host.seek(added.start);
  }
  addCue() {
    const start = round(
      bounded(this.host.sourceTime() - this.draft.captionShift, 0, Math.max(0, this.duration - 0.1)),
    );
    const added = { start, end: Math.min(this.duration, round(start + 2)), text: "" };
    this.cueId = this.job.captionCount + this.draft.addedCaptions.length;
    this.draft.addedCaptions.push(added);
    this.draft.captions = true;
    this.captionCache = null;
    el("cue-search").value = "";
    this.paintSettings();
    this.paintCue();
    this.status();
    this.host.seek(bounded(start + this.draft.captionShift, 0, this.duration));
    el("cue-text").focus();
  }
  omitCue() {
    if (this.cueId < this.job.captionCount) {
      const cue = this.cue();
      this.editCue({ ...cue, skip: !cue.skip });
    } else {
      this.draft.addedCaptions.splice(this.cueId - this.job.captionCount, 1);
      this.cueId = Math.max(0, this.cueId - 1);
      this.captionCache = null;
      if (!this.hasCaptions) this.draft.captions = false;
      this.host.captionChanged();
      this.status();
      this.paintSettings();
    }
    this.paintCue();
  }
  cueLabel(c) {
    return (
      (c.skip ? "제외 · " : "") +
      precise(Math.max(0, c.start + this.draft.captionShift)) +
      "  " +
      (c.text.slice(0, 65) || "새 자막")
    );
  }
  paintCue() {
    const all = this.allCues(),
      has = all.length > 0;
    el("add-cue").disabled = this.locked || !this.cues;
    el("no-cues").hidden = has;
    el("cue-form").hidden = !has;
    if (!has) {
      if (this.tab === "captions") this.track.hide();
      return;
    }
    const select = el("cue-select");
    select.replaceChildren();
    const search = el("cue-search").value.trim().toLowerCase();
    for (const [i, c] of [...all.entries()].sort((a, b) => a[1].start - b[1].start)) {
      if (search && !c.text.toLowerCase().includes(search)) continue;
      select.append(new Option(this.cueLabel(c), String(i)));
    }
    const empty = !select.options.length;
    if (empty) select.append(new Option("일치하는 문장이 없어요.", ""));
    if (!empty && ![...select.options].some((o) => o.value === String(this.cueId)))
      this.cueId = Number(select.options[0].value);
    const cue = this.cue() ?? all[0];
    select.value = String(this.cueId);
    el("cue-text").value = cue.text;
    if (empty) {
      select.selectedIndex = 0;
      el("cue-text").value = "";
    }
    select.disabled = empty;
    el("play-cue").disabled = empty;
    el("omit-cue").disabled = this.locked || empty;
    el("omit-cue").textContent =
      this.cueId >= this.job.captionCount
        ? "추가한 문장 삭제"
        : cue.skip
          ? "자막 다시 표시"
          : "자막만 숨기기";
    this.paintSpokenActions(cue, all, empty);
    el("cue-text").disabled = this.locked || empty;
    el("caption-shift").value = String(this.draft.captionShift);
    for (const id of ["shift-earlier", "caption-shift", "shift-later"]) el(id).disabled = this.locked;
    this.paintTimes("cue", cue);
    if (empty) {
      el("cue-times")
        .querySelectorAll("input,button")
        .forEach((c) => (c.disabled = true));
      if (this.tab === "captions") this.track.hide();
    }
  }
  paintSpokenActions(cue, all, empty = false) {
    if (this.mode !== "main") return;
    const canRemove = !empty && this.canRemoveSpoken(cue);
    el("omit-spoken").disabled = this.locked || !canRemove;
    el("omit-spoken").title = canRemove
      ? "표시된 시작과 끝 사이의 영상과 소리를 제외합니다."
      : "현재 본편에 포함된 대사를 선택하세요.";
    const pairs = repeatedLines(all);
    el("repeat-cue").hidden = pairs.length === 0;
    el("repeat-cue").textContent = "반복 대사 찾기 · " + pairs.length + "쌍";
    el("repeat-other").hidden =
      empty ||
      !pairs.some(([a, b]) => a === this.cueId && a === this.repeatPair?.[0] && b === this.repeatPair?.[1]);
  }
  editCue(value) {
    const item = { start: value.start, end: value.end, text: value.text };
    if (value.skip) item.skip = true;
    if (this.cueId >= this.job.captionCount)
      this.draft.addedCaptions[this.cueId - this.job.captionCount] = item;
    else {
      const original = this.cues[this.cueId];
      if (
        !item.skip &&
        item.start === original.start &&
        item.end === original.end &&
        item.text === original.text
      )
        delete this.draft.captionEdits[this.cueId];
      else this.draft.captionEdits[this.cueId] = item;
    }
    this.captionCache = null;
    const option = el("cue-select").selectedOptions[0];
    if (option) option.textContent = this.cueLabel(value);
    this.paintSpokenActions(value, this.allCues());
    this.host.captionChanged();
    this.status();
  }
  removeSpoken() {
    const cue = this.cue();
    if (!cue || this.locked || this.mode !== "main") return;
    const a = bounded(cue.start + this.draft.captionShift, 0, this.duration),
      b = bounded(cue.end + this.draft.captionShift, 0, this.duration);
    const clips = this.clips();
    if (!this.canRemoveSpoken(cue)) return;
    this.rememberCut();
    omitWindow(this.draft, clips, a, b, this.cutCues());
    this.anchor = (a + b) / 2;
    this.marked.clear();
    const right = this.clips().find((c) => c.start >= b - 0.001 && this.draft.ids.includes(c.id));
    if (right) this.active.main = right.id;
    this.paintRows();
    this.paintCue();
    this.status();
    this.feedback(
      "선택한 대사의 영상과 소리를 본편에서 뺐어요." +
        (el("review-join").disabled ? "" : " 이음새 듣기로 연결을 확인하세요."),
    );
  }
  canRemoveSpoken(cue) {
    if (!cue || this.mode !== "main") return false;
    const a = Math.max(0, cue.start + this.draft.captionShift),
      b = Math.min(this.duration, cue.end + this.draft.captionShift);
    return (
      b - a >= frame - 0.001 &&
      this.rowClips.some((c) => this.draft.ids.includes(c.id) && c.start < b && c.end > a)
    );
  }
  findRepeat() {
    const pairs = repeatedLines(this.allCues());
    if (!pairs.length) return;
    const last = pairs.findIndex((p) => p[0] === this.repeatPair?.[0]);
    this.repeatPair = pairs[(last + 1) % pairs.length];
    this.cueId = this.repeatPair[0];
    el("cue-search").value = "";
    this.paintCue();
    this.playLine(this.cue());
    this.feedback("같은 문구가 다시 나와요. ‘비교 구간 듣기’로 두 번째 발화를 확인할 수 있어요.");
  }
  shift(value) {
    if (!Number.isFinite(value) || Math.abs(value) > 60) {
      this.feedback("전체 이동은 −60초에서 +60초까지 지정할 수 있어요.");
      this.paintCue();
      return;
    }
    this.draft.captionShift = round(value);
    this.feedback("");
    this.paintCue();
    this.status();
    this.host.captionChanged();
  }
  playCue() {
    const c = this.cue();
    if (!c) return;
    this.playLine(c);
  }
  playLine(c) {
    const shift = this.draft.captionShift;
    this.host.audition(
      bounded(c.start + shift - 0.45, 0, this.duration),
      bounded(c.end + shift + 0.45, 0, this.duration),
      true,
    );
  }
  activeCaption(sourceTime) {
    if (!this.draft?.captions || !this.cues) return "";
    if (!this.captionCache) {
      let maxEnd = 0;
      this.captionCache = this.allCues()
        .filter((c) => !c.skip)
        .sort((a, b) => a.start - b.start)
        .map((c) => ({ ...c, maxEnd: (maxEnd = Math.max(maxEnd, c.end)) }));
    }
    const list = this.captionCache,
      at = sourceTime - this.draft.captionShift;
    let low = 0,
      high = list.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (list[mid].start <= at) low = mid + 1;
      else high = mid;
    }
    const lines = [];
    for (let i = low - 1; i >= 0 && list[i].maxEnd > at; i--) {
      if (list[i].end > at) lines.unshift(list[i].text);
    }
    return lines.join("\n");
  }
  paintSettings() {
    document.querySelectorAll("[data-setting]").forEach((input) => {
      const key = input.dataset.setting;
      input.checked = this.draft[key];
      input.disabled =
        this.locked ||
        (key === "narration" && !this.config.voice) ||
        (key === "captions" && !this.hasCaptions) ||
        (key === "emphasis" && (!this.draft.captions || !this.hasCaptions));
    });
    el("font").value = this.draft.font;
    el("font").disabled = this.locked || !this.draft.captions;
    document.querySelectorAll("[data-look]").forEach((b) => {
      b.setAttribute("aria-pressed", b.dataset.look === this.draft.look);
      b.disabled = this.locked;
    });
    el("crop-position").hidden = this.mode !== "crop";
    el("crop-x").value = this.draft.cropX;
    el("crop-y").value = this.draft.cropY;
    const ratio = this.job.info.displayRatio ?? this.job.info.width / this.job.info.height;
    const cropsSides = ratio > 9 / 16 + 0.001;
    const cropsEnds = ratio < 9 / 16 - 0.001;
    const centered =
      (!cropsSides || this.draft.cropX === defaults.cropX) &&
      (!cropsEnds || this.draft.cropY === defaults.cropY);
    el("screen").style.setProperty("--crop-x", this.draft.cropX + "%");
    el("screen").style.setProperty("--crop-y", this.draft.cropY + "%");
    el("crop-x").closest("label").hidden = !cropsSides;
    el("crop-y-field").hidden = !cropsEnds;
    el("crop-center").disabled = this.locked || centered;
    let description = "원본 전체가 세로 화면에 들어와요.";
    if (cropsSides)
      description = centered
        ? "좌우를 같은 만큼 잘라 원본의 정중앙을 보여줘요."
        : "원본의 " + (this.draft.cropX < 50 ? "왼쪽" : "오른쪽") + "으로 구도를 옮겼어요.";
    if (cropsEnds)
      description = centered
        ? "위아래를 같은 만큼 잘라 원본의 정중앙을 보여줘요."
        : "원본의 " + (this.draft.cropY < 50 ? "위쪽" : "아래쪽") + "으로 구도를 옮겼어요.";
    el("crop-description").textContent = description;
    for (const id of ["crop-x", "crop-y"]) el(id).disabled = this.locked;
  }
  style(key, value) {
    this.draft[key] = value;
    this.paintSettings();
    this.status();
    this.previewSoon();
  }
  previewSoon(delay = 280, playhead = false) {
    clearTimeout(this.previewTimer);
    const jobId = this.job.id,
      mode = this.mode;
    this.previewTimer = setTimeout(async () => {
      if (this.tab !== "style" || this.host.isHidden() || this.error() || this.locked) return;
      let at = this.host.sourceTime();
      if (!playhead && this.draft.captions && this.hasCaptions) {
        await this.loadCues();
        if (this.job?.id !== jobId || this.mode !== mode || this.tab !== "style") return;
        if (!this.activeCaption(at)) {
          const included = this.clips().filter((c) => this.draft.ids.includes(c.id));
          const candidates = this.allCues()
            .filter((c) => !c.skip)
            .map((c) => (c.start + c.end) / 2 + this.draft.captionShift)
            .filter((t) => included.some((c) => c.start <= t && t < c.end));
          if (candidates.length)
            at = candidates.reduce((best, t) => (Math.abs(t - at) < Math.abs(best - at) ? t : best));
        }
      }
      this.host.preview(this.payload(), at);
    }, delay);
  }
  timeTotal() {
    return durationOf(keptSpans(this.clips(), this.draft.ids));
  }
  error() {
    if (!this.draft.ids.length) return "편집본에 포함할 장면을 하나 이상 골라 주세요.";
    if ([...Object.values(this.draft.captionEdits), ...this.draft.addedCaptions].some((c) => !c.text.trim()))
      return "비어 있는 자막 문장을 입력해 주세요.";
    if (this.mode !== "main" && this.timeTotal() + (this.draft.narration ? 5 : 0) > 60)
      return "쇼츠는 60초 이내예요. 장면의 길이를 줄여 주세요.";
    return "";
  }
  status() {
    const changed = this.changed(),
      error = this.error(),
      locked = this.locked;
    el("apply").disabled = !changed || !!error || locked;
    el("undo").disabled = !changed || locked;
    const history = this.histories[this.mode];
    el("cut-undo").disabled = locked || !history.undo.length;
    el("cut-redo").disabled = locked || !history.redo.length;
    if (this.mode === "main") {
      el("review-all").textContent = changed ? "초안 전체 재생" : "저장본 전체 재생";
    }
    el("clip-count").textContent =
      this.draft.ids.length +
      "개 장면 · " +
      Math.round(this.timeTotal() * 10) / 10 +
      "초" +
      (this.draft.narration ? " + 도입" : "");
    let state = "저장된 편집본";
    const cache = this.draftCaches[this.mode];
    if (changed) {
      const area = cache.save(
        normalized(this.draft),
        this.active[this.mode],
        this.mode === "main" ? this.anchor : null,
      );
      state =
        area === "browser"
          ? "이 브라우저에 초안 임시 저장됨"
          : area === "tab"
            ? "이 탭에 초안 임시 저장됨"
            : "임시 저장 불가 · 변경 저장을 눌러 주세요.";
    } else cache.discard();
    el("draft-status").textContent = error || state;
    el("draft-status").classList.toggle("warn", !!error);
    for (const id of ["download", "srt"]) {
      const link = el(id);
      link.setAttribute("aria-disabled", String(changed || locked));
      link.title = changed ? "변경 저장 후 다운로드할 수 있어요." : "";
    }
  }
}

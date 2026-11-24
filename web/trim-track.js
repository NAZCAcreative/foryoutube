const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const millis = (value) => Math.round(value * 1000) / 1000;

export class TrimTrack {
  constructor(root, format, commit, seek) {
    this.root = root;
    this.format = format;
    this.commit = commit;
    this.seek = seek;
    this.canvas = root.querySelector("canvas");
    this.area = root.querySelector(".wave-area");
    this.window = root.querySelector(".wave-window");
    this.playhead = root.querySelector(".wave-cursor");
    this.handles = [...root.querySelectorAll("[role=slider]")];
    this.area.onpointerdown = (event) => {
      if (event.button === 0 && !event.target.closest("[role=slider]")) this.seek(this.timeAt(event.clientX));
    };
    for (const handle of this.handles) {
      const key = handle.dataset.edge;
      handle.onpointerdown = (event) => {
        if (handle.disabled || event.button !== 0) return;
        this.drag = { key, initial: this.values[key], pointer: event.pointerId };
        handle.setPointerCapture(event.pointerId);
      };
      handle.onpointermove = (event) => {
        if (this.drag?.pointer !== event.pointerId || this.drag.key !== key) return;
        this.showValue(key, this.timeAt(event.clientX));
      };
      handle.onpointerup = (event) => {
        if (this.drag?.pointer !== event.pointerId || this.drag.key !== key) return;
        const changed = this.values[key] !== this.drag.initial;
        this.drag = null;
        if (changed) this.commit(this.kind, key, this.values[key]);
      };
      handle.onlostpointercapture = () => {
        if (this.drag?.key === key) {
          this.showValue(key, this.drag.initial);
          this.drag = null;
        }
      };
      handle.onkeydown = (event) => {
        const direction = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key];
        if (!direction) return;
        event.preventDefault();
        this.showValue(key, this.values[key] + direction * (event.shiftKey ? 1 : 0.1));
        this.commit(this.kind, key, this.values[key]);
      };
    }
  }
  clear() {
    this.drag = null;
    this.root.hidden = true;
    this.jobId = null;
    this.peaks = null;
    this.canvas.hidden = true;
    this.request?.abort();
    this.request = null;
  }
  async load(job) {
    if (this.jobId === job.id) return;
    this.clear();
    this.jobId = job.id;
    if (!job.info.audio) return;
    const request = new AbortController();
    this.request = request;
    try {
      const response = await fetch("/api/jobs/" + job.id + "/waveform", { signal: request.signal });
      if (!response.ok) throw new Error();
      const rate = Number(response.headers.get("X-Peaks-Per-Second"));
      const peaks = new Uint8Array(await response.arrayBuffer());
      if (request.signal.aborted || !rate || !peaks.length) return;
      this.rate = rate;
      this.peaks = peaks;
      if (this.kind && this.values) {
        this.canvas.hidden = false;
        document.getElementById("wave-type").textContent = "소리 파형";
        this.root.hidden = false;
        this.draw();
      }
    } catch {
      if (!request.signal.aborted) this.jobId = null;
    }
  }
  hide() {
    this.kind = null;
    this.root.hidden = true;
  }
  display(kind, start, end, duration, at, locked) {
    if (this.drag) return;
    this.kind = kind;
    this.values = { start, end };
    this.duration = duration;
    const padding = Math.max(1.25, Math.min(8, (end - start) * 0.3));
    this.left = Math.max(0, start - padding);
    this.right = Math.min(duration, end + padding);
    const holder = document.getElementById(kind + "-wave-place");
    if (this.root.parentElement !== holder) holder.append(this.root);
    this.root.hidden = false;
    this.canvas.hidden = !this.peaks;
    document.getElementById("wave-type").textContent = this.peaks ? "소리 파형" : "구간 위치";
    this.handles.forEach((handle) => {
      handle.disabled = locked;
    });
    this.position();
    this.tick(at);
    if (this.peaks) this.draw();
  }
  timeAt(x) {
    const rect = this.area.getBoundingClientRect();
    return millis(this.left + clamp((x - rect.left) / rect.width, 0, 1) * (this.right - this.left));
  }
  fraction(time) {
    return (100 * (time - this.left)) / (this.right - this.left) + "%";
  }
  showValue(key, value) {
    const gap = Math.min(1 / 24, this.duration);
    const low = key === "start" ? this.left : Math.max(this.left, this.values.start + gap);
    const high = key === "end" ? this.right : Math.min(this.right, this.values.end - gap);
    this.values[key] = millis(clamp(value, low, high));
    document.getElementById(this.kind + "-" + key).value = this.format(this.values[key]);
    this.position();
  }
  position() {
    const { start, end } = this.values;
    this.window.style.left = this.fraction(start);
    this.window.style.width = (100 * (end - start)) / (this.right - this.left) + "%";
    for (const handle of this.handles) {
      const key = handle.dataset.edge,
        at = this.values[key];
      handle.style.left = this.fraction(at);
      handle.setAttribute("aria-valuemin", String(key === "start" ? this.left : start));
      handle.setAttribute("aria-valuemax", String(key === "end" ? this.right : end));
      handle.setAttribute("aria-valuenow", String(at));
      handle.setAttribute("aria-valuetext", this.format(at));
      handle.title = (key === "start" ? "시작 " : "끝 ") + this.format(at);
    }
  }
  tick(time) {
    if (!this.kind) return;
    this.playhead.hidden = time < this.left || time > this.right;
    if (!this.playhead.hidden) this.playhead.style.left = this.fraction(time);
  }
  draw() {
    const ctx = this.canvas.getContext("2d");
    const width = this.canvas.width,
      height = this.canvas.height,
      bars = width / 4;
    const values = new Uint8Array(bars),
      step = ((this.right - this.left) * this.rate) / bars;
    let maximum = 55;
    for (let i = 0; i < bars; i++) {
      const a = Math.floor(this.left * this.rate + i * step);
      const b = Math.min(
        this.peaks.length,
        Math.max(a + 1, Math.ceil(this.left * this.rate + (i + 1) * step)),
      );
      for (let j = a; j < b; j++) values[i] = Math.max(values[i], this.peaks[j]);
      maximum = Math.max(maximum, values[i]);
    }
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#90b597";
    for (let i = 0; i < bars; i++) {
      const size = Math.max(1, (values[i] / maximum) * (height - 8));
      ctx.fillRect(i * 4, (height - size) / 2, 2.6, size);
    }
  }
}

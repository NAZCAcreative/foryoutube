const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isRange = (value) => isObject(value) && Number.isFinite(value.start) && Number.isFinite(value.end);
const isCue = (value) => isRange(value) && typeof value.text === "string";

function decode(raw) {
  try {
    const record = JSON.parse(raw);
    const s = record?.settings;
    if (
      isObject(s) &&
      Array.isArray(s.ids) &&
      s.ids.every((id) => typeof id === "string") &&
      isObject(s.ranges) &&
      Object.values(s.ranges).every(isRange) &&
      Array.isArray(s.custom) &&
      s.custom.every((c) => isRange(c) && typeof c.id === "string" && typeof c.title === "string") &&
      isObject(s.captionEdits) &&
      Object.values(s.captionEdits).every(isCue) &&
      Array.isArray(s.addedCaptions) &&
      s.addedCaptions.every(isCue)
    )
      return record;
  } catch {
    /* Browser storage can contain an interrupted or obsolete entry. */
  }
  return null;
}

export class DraftCache {
  constructor(job, mode, revision, browser = globalThis) {
    this.key = ["cutroom.draft.v1", job, mode, revision].join("/");
    this.browser = browser;
    this.raw = null;
    this.area = null;
  }
  read(area) {
    try {
      return this.browser[area].getItem(this.key);
    } catch {
      return null;
    }
  }
  write(area, raw) {
    try {
      this.browser[area].setItem(this.key, raw);
      return true;
    } catch {
      return false;
    }
  }
  restore() {
    const session = this.read("sessionStorage");
    if (session === "discarded") return null;
    const shared = this.read("localStorage");
    for (const raw of [session, shared]) {
      const record = raw && decode(raw);
      if (record) {
        this.raw = raw;
        this.area = shared === raw ? "browser" : "tab";
        return record;
      }
    }
    return null;
  }
  save(settings, active, anchor) {
    const raw = JSON.stringify({ settings, active, anchor });
    if (raw === this.raw && this.area) return this.area;
    const shared = this.read("localStorage");
    // A simultaneous edit in another tab keeps its own copy at this revision.
    const ownsShared = !shared || shared === this.raw || !decode(shared);
    const durable = ownsShared && this.write("localStorage", raw);
    const session = this.write("sessionStorage", raw);
    this.raw = raw;
    this.area = durable ? "browser" : session ? "tab" : null;
    return this.area;
  }
  discard(explicit = false) {
    if (this.raw) {
      for (const area of ["sessionStorage", "localStorage"]) {
        try {
          if (this.read(area) === this.raw) this.browser[area].removeItem(this.key);
        } catch {
          /* The current edit remains available in memory. */
        }
      }
    }
    this.raw = null;
    this.area = null;
    if (explicit) this.write("sessionStorage", "discarded");
  }
}

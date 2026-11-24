// The editor keeps adjacent pieces separate. Export joins their coverage before encoding.
export const frame = 1 / 24;
const tolerance = 0.0005;
const minimum = frame - 0.001;
const millis = (t) => Math.round(t * 1000) / 1000;

export function keptSpans(clips, ids) {
  const included = new Set(ids);
  const spans = [];
  for (const c of clips) {
    if (!included.has(c.id)) continue;
    const previous = spans.at(-1);
    if (previous && c.start <= previous.end + tolerance) previous.end = Math.max(previous.end, c.end);
    else spans.push({ start: c.start, end: c.end });
  }
  return spans;
}

export function durationOf(spans) {
  return spans.reduce((sum, c) => sum + Math.max(1, Math.round((c.end - c.start) / frame)), 0) * frame;
}

export function overlapDuration(left, right) {
  let i = 0,
    j = 0,
    seconds = 0;
  while (i < left.length && j < right.length) {
    const a = left[i],
      b = right[j];
    seconds += Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
    if (a.end <= b.end) i++;
    else j++;
  }
  return seconds;
}

export function manualPoint(clip, at) {
  if (!clip || !Number.isFinite(at) || at - clip.start < minimum || clip.end - at < minimum) return null;
  const value = millis(clip.start + Math.round((at - clip.start) / frame) * frame);
  return value - clip.start >= minimum && clip.end - value >= minimum ? value : null;
}

function regularPoints(a, b, seconds) {
  const result = [];
  if (!Number.isFinite(seconds) || seconds <= 0) return result;
  for (let t = a + seconds; t <= b - 0.5; t += seconds) result.push(millis(t));
  return result;
}

export function suggestedPoints(clip, cues, rule) {
  if (rule !== "speech") return regularPoints(clip.start, clip.end, Number(rule));
  const speech = cues
    .filter((c) => c.start < clip.end && c.end > clip.start)
    .sort((a, b) => a.start - b.start);
  if (!speech.length) return regularPoints(clip.start, clip.end, 5);
  const points = [];
  let cursor = clip.start;
  function gap(a, b, between) {
    if (b < a) return;
    let candidates = [];
    if (b - a >= 8) candidates = [a, ...regularPoints(a, b, 5), b];
    else if (between) candidates = [(a + b) / 2];
    for (const candidate of candidates) {
      const t = millis(candidate);
      if (t - (points.at(-1) ?? clip.start) >= 0.5 && clip.end - t >= 0.5) points.push(t);
    }
  }
  speech.forEach((cue, i) => {
    gap(cursor, Math.max(clip.start, cue.start), i > 0);
    cursor = Math.max(cursor, Math.min(cue.end, clip.end));
  });
  gap(cursor, clip.end, false);
  return points;
}

export function textForPiece(part, cues) {
  let longest = 0;
  let label = cues.length ? "대사 사이 구간" : "영상 구간";
  for (const cue of cues) {
    const overlap = Math.min(part.end, cue.end) - Math.max(part.start, cue.start);
    if (overlap > longest && cue.text?.trim()) {
      longest = overlap;
      label = cue.text.trim();
    }
  }
  return label.slice(0, 100);
}

// Reuse the parent's ID for the first piece so older recommendations and custom cuts remain addressable.
function replaceClip(draft, clip, parts, cues) {
  const included = new Set(draft.ids);
  included.delete(clip.id);
  const result = parts.map((part, i) => {
    const range = { start: part.start, end: part.end };
    const id = i === 0 ? clip.id : "custom-" + crypto.randomUUID();
    if (i === 0) {
      if (range.start !== clip.start || range.end !== clip.end) draft.ranges[id] = range;
    } else draft.custom.push({ id, ...range, title: textForPiece(part, cues) });
    if (part.included) included.add(id);
    return id;
  });
  draft.ids = [...included];
  return result;
}

export function splitClip(draft, clip, points, cues) {
  const edges = [clip.start];
  for (const p of points) {
    if (p - edges.at(-1) >= minimum && clip.end - p >= minimum) edges.push(p);
  }
  if (edges.length === 1) return [];
  edges.push(clip.end);
  const included = draft.ids.includes(clip.id);
  return replaceClip(
    draft,
    clip,
    edges.slice(1).map((end, i) => ({ start: edges[i], end, included })),
    cues,
  );
}

export function omitWindow(draft, clips, start, end, cues) {
  if (end - start < minimum) return false;
  const included = new Set(draft.ids);
  let changed = false;
  for (const clip of clips) {
    if (!included.has(clip.id) || clip.end <= start || clip.start >= end) continue;
    let a = Math.max(clip.start, start),
      b = Math.min(clip.end, end);
    if (a - clip.start < minimum) a = clip.start;
    if (clip.end - b < minimum) b = clip.end;
    const parts = [];
    if (a > clip.start) parts.push({ start: clip.start, end: a, included: true });
    if (b - a >= minimum) parts.push({ start: a, end: b, included: false });
    if (b < clip.end) parts.push({ start: b, end: clip.end, included: true });
    if (!parts.length) continue;
    replaceClip(draft, clip, parts, cues);
    changed = true;
  }
  return changed;
}

export function reviewSpans(spans, kind, at) {
  if (kind === "join") {
    if (spans.length < 2) return [];
    let index = 1,
      closest = Infinity;
    for (let i = 1; i < spans.length; i++) {
      const distance = Math.max(spans[i - 1].end - at, at - spans[i].start, 0);
      if (distance < closest) {
        index = i;
        closest = distance;
      }
    }
    const a = spans[index - 1],
      b = spans[index];
    return [
      { start: Math.max(a.start, a.end - 2), end: a.end },
      { start: b.start, end: Math.min(b.end, b.start + 2) },
    ];
  }
  if (kind !== "opening") return spans.map((c) => ({ ...c }));
  let left = 30;
  const result = [];
  for (const c of spans) {
    if (left <= tolerance) break;
    const length = Math.min(left, c.end - c.start);
    result.push({ start: c.start, end: c.start + length });
    left -= length;
  }
  return result;
}

export function repeatedLines(cues) {
  const last = new Map(),
    pairs = [];
  const ordered = cues
    .map((cue, index) => ({ cue, index }))
    .filter(({ cue }) => !cue.skip)
    .sort((a, b) => a.cue.start - b.cue.start);
  for (const { cue, index } of ordered) {
    // Keep speaker prefixes in the key; a learner echoing a teacher can be part of the lesson.
    const line = cue.text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
    if (line.length < 9) continue;
    const prev = last.get(line);
    if (prev && cue.start >= prev.end && cue.start - prev.end <= 45) pairs.push([prev.index, index]);
    last.set(line, { index, end: cue.end });
  }
  return pairs;
}

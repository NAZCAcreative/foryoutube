import test from "node:test";
import assert from "node:assert/strict";
import {
  durationOf,
  keptSpans,
  manualPoint,
  omitWindow,
  overlapDuration,
  repeatedLines,
  reviewSpans,
  splitClip,
  suggestedPoints,
  textForPiece,
} from "../web/cut-plan.js";

const base = { id: "main-0", title: "질문과 답변", start: 5.753, end: 34.467 };
const fresh = () => ({ ids: [base.id], ranges: {}, custom: [] });

test("comparison counts only intersecting source time across different cut boundaries", () => {
  const recommended = [
    { start: 1, end: 10 },
    { start: 17, end: 21 },
  ];
  assert.equal(
    overlapDuration(recommended, [
      { start: 2, end: 4 },
      { start: 5, end: 18 },
      { start: 21, end: 28 },
    ]),
    8,
  );
  assert.equal(overlapDuration(recommended, []), 0);
});
const clips = (draft, originals = [base]) =>
  [...originals, ...draft.custom]
    .map((c) => ({ ...c, ...draft.ranges[c.id] }))
    .sort((a, b) => a.start - b.start);

test("splitting at the playhead preserves all frames, and splitting an excluded custom piece keeps it excluded", () => {
  const d = fresh(),
    before = durationOf(keptSpans([base], d.ids));
  const pt = manualPoint(base, 15);
  assert.ok(Math.abs(pt - 15) < 1 / 24);
  assert.equal(manualPoint(base, base.start + 0.005), null);
  const ids = splitClip(d, base, [pt], []);
  assert.equal(ids[0], base.id);
  assert.equal(durationOf(keptSpans(clips(d), d.ids)), before);
  d.ids = d.ids.filter((id) => id !== ids[1]);
  const right = clips(d).find((c) => c.id === ids[1]);
  const children = splitClip(d, right, [22.25], []);
  assert.ok(children.every((id) => !d.ids.includes(id)));
  assert.equal(clips(d).at(-1).end, base.end);
});

test("sentence divisions avoid overlapping speech; silent spans and fixed interval divisions cover the original", () => {
  const c = { ...base, start: 0, end: 20 };
  const cues = [
    { start: 0, end: 4 },
    { start: 2, end: 6 },
    { start: 7, end: 10 },
    { start: 10, end: 20 },
  ];
  assert.deepEqual(suggestedPoints(c, cues, "speech"), [6.5, 10]);
  assert.deepEqual(suggestedPoints(c, [], "speech"), [5, 10, 15]);
  assert.deepEqual(suggestedPoints(c, cues, "10"), [10]);
  assert.deepEqual(suggestedPoints({ ...c, end: 4.95 }, [], "5"), []);
});

test("omitting a sentence removes it from all overlapping kept ranges and preserves excluded material", () => {
  const extra = { id: "main-1", title: "겹친 장면", start: 14.5, end: 18 };
  const d = { ...fresh(), ids: [base.id, extra.id] };
  assert.ok(omitWindow(d, clips(d, [base, extra]), 15, 17, []));
  const result = keptSpans(clips(d, [base, extra]), d.ids);
  assert.deepEqual(result, [
    { start: base.start, end: 15 },
    { start: 17, end: base.end },
  ]);
  assert.equal(Math.round((durationOf([base]) - durationOf(result)) * 24), 48);
  assert.ok(
    clips(d, [base, extra])
      .filter((c) => c.start === 15 && c.end === 17)
      .every((c) => !d.ids.includes(c.id)),
  );
  assert.equal(omitWindow(d, clips(d, [base, extra]), 15, 17, []), false);
});

test("a short fragment displays the speech heard there, including fragments without a cue midpoint", () => {
  const cues = [
    { start: 6, end: 16, text: "선생님 · 분모를 먼저 봐요." },
    { start: 18, end: 24, text: "학생 · 이제 알겠어요." },
  ];
  assert.equal(textForPiece({ start: 13, end: 15 }, cues), cues[0].text);
  assert.equal(textForPiece({ start: 15.5, end: 20 }, cues), cues[1].text);
  assert.equal(textForPiece({ start: 16, end: 18 }, cues), "대사 사이 구간");
  assert.equal(textForPiece({ start: 16, end: 18 }, []), "영상 구간");
  const d = fresh();
  splitClip(d, base, [13, 15], cues);
  assert.equal(d.custom[0].title, cues[0].text);
});

test("opening and nearest join review use only retained source intervals", () => {
  const spans = [
    { start: 1, end: 12 },
    { start: 20, end: 39 },
    { start: 70, end: 84 },
  ];
  assert.deepEqual(reviewSpans(spans, "opening", 0), spans.slice(0, 2));
  assert.deepEqual(reviewSpans(spans, "join", 48), [
    { start: 37, end: 39 },
    { start: 70, end: 72 },
  ]);
  assert.deepEqual(reviewSpans(spans.slice(0, 1), "join", 10), []);
});

test("suggest only nearby matching utterances, with no automatic removal", () => {
  const text = "선생님 · 분모가 같으면 분자를 비교해요.";
  const c = (start, text) => ({ start, end: start + 2, text });
  const cues = [c(0, text), c(5, text.replace(".", "!")), c(8, text.replace("선생님", "학생")), c(60, text)];
  assert.deepEqual(repeatedLines(cues), [[0, 1]]);
});

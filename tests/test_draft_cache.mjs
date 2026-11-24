import test from "node:test";
import assert from "node:assert/strict";
import { DraftCache } from "../web/draft-cache.js";

function storage() {
  const data = new Map();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
}
const browser = () => ({ sessionStorage: storage(), localStorage: storage() });
const settings = (look) => ({
  look,
  ids: ["main-0"],
  ranges: {},
  custom: [],
  addedCaptions: [],
  captionEdits: {},
});

test("restore, refresh, discard and a new saved revision", () => {
  const b = browser();
  const open = (revision = "a") => new DraftCache("job", "main", revision, b);
  const edit = open();
  assert.equal(edit.restore(), null);
  assert.equal(edit.save(settings("warm"), "main-0", 2.5), "browser");
  const restored = open();
  assert.deepEqual(restored.restore(), { settings: settings("warm"), active: "main-0", anchor: 2.5 });
  assert.equal(open("b").restore(), null);
  assert.equal(new DraftCache("job", "crop", "a", b).restore(), null);
  assert.equal(new DraftCache("another-job", "main", "a", b).restore(), null);
  restored.discard();
  assert.equal(open().restore(), null);
});

test("diverging tabs recover their own edits and discard only the matching snapshot", () => {
  const a = browser();
  const b = { ...a, sessionStorage: storage() };
  const left = new DraftCache("job", "main", "a", a);
  const right = new DraftCache("job", "main", "a", b);
  left.restore();
  right.restore();
  assert.equal(left.save(settings("warm"), "one", 1), "browser");
  assert.equal(right.save(settings("mono"), "two", 2), "tab");
  assert.equal(new DraftCache("job", "main", "a", b).restore().settings.look, "mono");
  assert.equal(new DraftCache("job", "main", "a", a).restore().settings.look, "warm");
  right.discard(true);
  assert.equal(new DraftCache("job", "main", "a", b).restore(), null);
  assert.equal(
    new DraftCache("job", "main", "a", { ...a, sessionStorage: storage() }).restore().settings.look,
    "warm",
  );
});

test("opening a new tab recovers the durable draft; full or malformed storage cannot break editing", () => {
  const a = browser();
  const draft = new DraftCache("job", "short", "r", a);
  a.localStorage.setItem(draft.key, "{");
  assert.equal(draft.restore(), null);
  draft.save(settings("original"), "short-0", null);
  const reopened = new DraftCache("job", "short", "r", { ...a, sessionStorage: storage() });
  assert.equal(reopened.restore().active, "short-0");
  const blocked = new DraftCache("job", "short", "r", {});
  assert.equal(blocked.restore(), null);
  assert.equal(blocked.save(settings("original"), "short-0", null), null);
});

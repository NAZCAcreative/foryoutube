from __future__ import annotations

import html
import math
import re
import unicodedata
from bisect import bisect_left, bisect_right
from pathlib import Path

PLAN_VERSION = 3


CLOCK = re.compile(r"(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})")
QUESTION = re.compile(r"[?？]|왜|어떻게|궁금|질문|될까요|인가요|맞나요|진짜")
REACTION = re.compile(r"아하|어\?|아니|깨달|알겠|드디어|그렇구나|그러네요|그러니까|놀랍|반전|신기|웃음|하하|어라|헷갈|오히려|그랬")
EXPLANATION = re.compile(r"그래서|왜냐|예를 들|핵심|중요|다시 말|정리|결과|차이|비교|이유|실제로|직접")
FILLER = re.compile(r"마이크 확인|들리시|화면 공유 준비|접속 확인|연결 확인|음소거 해제")
ASKS = re.compile(r"[?？]|(?:까요|나요|인가요|뭐죠|겁니까|습니까)[.!…\s]*$|^(?:그런데\s*)?(?:왜(?!냐)|어떻게\s)")
SPEAKER = re.compile(r"^(선생님|강사|학생|교사|내레이션)\s*[:·]\s*")


def parse_time(match):
    hour, minute, second, millis = match.groups()
    return int(hour or 0) * 3600 + int(minute) * 60 + int(second) + int(millis.ljust(3, "0")) / 1000


def parse_captions(path: Path, duration: float):
    raw = path.read_bytes()
    try:
        source = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        source = raw.decode("cp949", errors="replace")
    cues = []
    for block in re.split(r"\n\s*\n", source.replace("\r\n", "\n").replace("\r", "\n").strip()):
        lines = block.splitlines()
        for i, line in enumerate(lines):
            times = list(CLOCK.finditer(line))
            if "-->" not in line or len(times) < 2:
                continue
            start, end = max(0, parse_time(times[0])), min(duration, parse_time(times[1]))
            body = re.sub(r"<v\s+([^>]+)>", r"\1 · ", " ".join(lines[i + 1:]))
            body = html.unescape(re.sub(r"<[^>]+>", "", body)).strip()
            if body and end > start:
                cues.append({"start": start, "end": end, "text": body[:1500]})
            break
    return sorted(cues, key=lambda cue: cue["start"])


def clean_line(text):
    return SPEAKER.sub("", text).strip()


def cue_weight(text):
    return 2.6 * bool(QUESTION.search(text)) + 2.5 * bool(REACTION.search(text)) + 2.1 * bool(EXPLANATION.search(text)) - 4 * bool(FILLER.search(text))


def line_features(text):
    # Character shingles survive spacing changes and small transcription differences in Korean.
    line = "".join(c for c in unicodedata.normalize("NFKC", clean_line(text)).casefold() if c.isalnum())
    return frozenset(line[i:i+6] for i in range(len(line)-5))


def question_replies(cues):
    speakers = []
    for cue in cues:
        tag = SPEAKER.match(cue["text"])
        name = tag[1] if tag else None
        speakers.append("교사" if name in ("강사", "선생님") else name)
    pairs = {}
    for i, question in enumerate(cues):
        line = clean_line(question["text"])
        if not ASKS.search(line) or FILLER.search(line):
            continue
        for j in range(i+1, min(i+4, len(cues))):
            reply = cues[j]
            answer = clean_line(reply["text"])
            if reply["start"] - question["end"] > 5 or ASKS.search(answer) or FILLER.search(answer):
                break
            if not answer or reply["start"] < question["end"] - 1:
                continue
            if speakers[i] and speakers[i] == speakers[j] and not EXPLANATION.search(answer):
                continue
            pairs[i] = j
            break
    return pairs


def intersect(a, b):
    return max(0.0, min(a["end"], b["end"]) - max(a["start"], b["start"]))


def speech_intervals(cues):
    intervals = []
    for cue in cues:
        a, b = cue["start"], cue["end"]
        if intervals and a < intervals[-1][1]:
            intervals[-1][1] = max(b, intervals[-1][1])
        else:
            intervals.append([a,b])
    return intervals


def remove_quiet_gaps(selected, cues, levels):
    if len(cues) < 2 or not levels:
        return selected, []
    duration = sum(s["end"] - s["start"] for s in selected)
    allowance = min(20, max(6,duration * .08))
    kept, removed = [], []
    spoken = speech_intervals(cues)
    for scene in selected:
        inside = [(a,b) for a,b in spoken if a < scene["end"] and scene["start"] < b]
        start = scene["start"]
        for left, right in zip(inside,inside[1:]):
            a,b = round(left[1]+.7,3),round(right[0]-.7,3)
            volume = levels[math.ceil(a):int(b)]
            if b-a < 4 or b-a > allowance or a-start < 1.5 or scene["end"]-b < 1.5 or not volume or max(volume) > .15:
                continue
            kept.append({**scene,"start":start,"end":a})
            removed.append({"start":a,"end":b,"title":"긴 무음 구간","reason":"대화 사이의 조용한 구간을 줄였어요"})
            start=b
            allowance-=b-a
        kept.append({**scene,"start":start})
    return kept,removed


def make_plan(duration, cues, levels, mode):
    short = mode == "short"
    if short:
        target = min(duration, 51.0, max(9.0, duration * .44))
        unit = target
    else:
        target = min(duration, min(555.0, max(300.0, duration * .135)) if duration >= 600 else max(9.0, duration * .62))
        unit = target / max(1, round(target / (55 if duration >= 600 else 20)))
    starts = [c["start"] for c in cues]
    spoken = speech_intervals(cues)
    speech_starts = [a for a,_ in spoken]
    ends = [b for _,b in spoken]
    limit = min(duration, 55.0 if short else unit * 1.17)
    pairs = question_replies(cues)
    lead_question = {reply: question for question, reply in pairs.items()}
    features = [line_features(c["text"]) for c in cues] if not short else []

    def before_line(t):
        pos = bisect_right(speech_starts, t) - 1
        if pos >= 0 and t < ends[pos]:
            t = speech_starts[pos]
        earlier = bisect_right(ends,t) - 1
        previous = ends[earlier] if earlier >= 0 else 0
        return max(0, t - min(.18, (t - previous) / 2))

    def after_line(t):
        next_index = bisect_left(speech_starts, t)
        next_start = speech_starts[next_index] if next_index < len(spoken) else duration
        return min(duration, t + min(.18, max(0, next_start - t) / 2))

    def candidate(anchor):
        start = min(max(0.0, anchor), max(0, duration - unit))
        if spoken:
            pos = bisect_right(speech_starts, start)
            if pos and ends[pos-1] > start and start - speech_starts[pos-1] < limit:
                start = before_line(speech_starts[pos-1])
            elif pos < len(spoken) and speech_starts[pos] - start <= min(5, unit * .25):
                start = before_line(speech_starts[pos])
            first = bisect_left(starts, start - .02)
            if first in lead_question and starts[first] - start <= 1.5:
                question_start = before_line(starts[lead_question[first]])
                if start - question_start <= 12 and cues[first]["end"] - question_start <= limit:
                    start = question_start
        end = min(duration, start + unit)
        near_ends = ends[bisect_left(ends,start+unit*.5):bisect_right(ends,start+limit-.18)]
        if near_ends:
            speech_end = min(near_ends, key=lambda t: abs(t - end))
            end = after_line(speech_end)
        # Keep a nearby answer with its question, or finish at the preceding exchange.
        first = max(0, bisect_left(starts, start) - 1)
        for i in range(first, bisect_left(starts, end)):
            if i not in pairs or starts[i] < start - .02 or starts[i] >= end:
                continue
            # Also preserve speech overlapping the end of the reply.
            reply_end = ends[bisect_left(ends, cues[pairs[i]]["end"])]
            if reply_end <= end:
                continue
            if reply_end <= start + limit:
                end = min(start + limit, after_line(reply_end))
            elif starts[i] - start >= min(3, unit / 2):
                previous = bisect_right(ends, starts[i]) - 1
                end = after_line(ends[previous]) if previous >= 0 and ends[previous] > start else starts[i]
                break
        if end - start < min(duration, 1/24) - .001 or end <= start:
            return None
        indices = [i for i in range(first, bisect_left(starts, end))
                   if min(end, cues[i]["end"]) - max(start, starts[i]) > .12]
        meaningful = [cues[i] for i in indices]
        speech = sum(min(end, c["end"]) - max(start, c["start"]) for c in meaningful)
        near_energy = levels[int(start):max(int(start) + 1, math.ceil(end))]
        activity = sum(near_energy) / max(len(near_energy), 1)
        top = sorted(meaningful, key=lambda c: cue_weight(c["text"]), reverse=True)
        words = " ".join(c["text"] for c in meaningful)
        score = sum(cue_weight(c["text"]) for c in top[:3]) / 3 + min(1, speech / (end - start)) + activity
        replies = [cues[pairs[i]] for i in indices if i in pairs and starts[i] >= start-.02 and cues[pairs[i]]["end"] <= end+.02]
        if replies:
            score += 1.8
        if meaningful:
            lead = clean_line(meaningful[0]["text"])
            if short and QUESTION.search(lead):
                score += .8
            if lead.startswith(("맞아요", "오른쪽", "왼쪽", "그러니까", "그래서", "네,")):
                score -= 1.5
        score -= min(3, len(FILLER.findall(words))) * .75
        if not meaningful and cues:
            score -= 7
        title = clean_line(top[0]["text"]) if top else "화면·소리 변화가 있는 장면"
        if replies:
            note = "질문과 뒤이은 반응" if any(REACTION.search(r["text"]) for r in replies) else "질문과 이어지는 답변"
        elif EXPLANATION.search(words):
            note = "개념 설명"
        elif REACTION.search(words):
            note = "대화 속 반응"
        else:
            note = "대화가 이어지는 구간" if meaningful else "영상 신호로 고른 구간"
        signature = frozenset().union(*(features[i] for i in indices)) if not short else frozenset()
        return {"start": round(start, 3), "end": round(end, 3), "title": title[:57], "reason": note, "score": score, "features": signature}

    stride = max(2, unit * .36)
    anchors = {0.0, max(0.0, duration - unit)}
    anchors.update(i * stride for i in range(1, math.ceil(duration / stride)))
    anchors.update(max(0, c["start"] - .35) for c in cues if QUESTION.search(c["text"]))
    options = {}
    for anchor in sorted(anchors):
        entry = candidate(anchor)
        if entry:
            options[(entry["start"], entry["end"])] = entry
    pool = sorted(options.values(), key=lambda e: -e["score"])
    chosen = []
    covered = set()
    used = 0.0
    while pool and used < target * .94:
        eligible = [item for item in pool if not any(intersect(item, prev) > .001 for prev in chosen)]
        if not eligible:
            break
        def priority(item):
            separation = min((abs(item["start"] - prev["start"]) for prev in chosen), default=duration)
            words = item["features"]
            overlap = len(covered.intersection(words)) / len(words) if words and covered else 0
            repetition = 6 * max(0, (overlap - .5) / .5)
            return item["score"] + min(2.3, separation / max(duration / 6, 1) * 2.3) - repetition
        entry = max(eligible, key=priority)
        chosen.append(entry)
        covered.update(entry["features"])
        used += entry["end"] - entry["start"]
        pool.remove(entry)
        if short:
            break
    chosen.sort(key=lambda item: item["start"])
    for scene in chosen:
        del scene["features"]
    chosen,extras = remove_quiet_gaps(chosen,cues,levels)
    # Restore a small piece next to a cut without overlapping any included scene.
    for selected in chosen:
        for a, b in ((max(0, selected["start"] - (3 if short else 7)),selected["start"]),
                     (selected["end"],min(duration,selected["end"] + (3 if short else 7)))):
            item = {"start": round(a, 3), "end": round(b, 3), "title": "앞뒤 맥락 복원", "reason": "자동 편집에서 제외한 인접 구간"}
            if b - a >= .75 and not any(intersect(item, other) > .001 for other in chosen + extras):
                extras.append(item)
            if len(extras) >= (1 if short else 3):
                break
        if len(extras) >= (1 if short else 3):
            break
    clips = []
    for i, item in enumerate(sorted(chosen + extras, key=lambda item: item["start"])):
        clips.append({**{k:v for k,v in item.items() if k != "score"}, "id": f"{mode}-{i}", "included": item in chosen})
    return clips


def srt_stamp(t):
    ms = max(0, round(t * 1000))
    seconds, fraction = divmod(ms, 1000)
    minutes, second = divmod(seconds, 60)
    hour, minute = divmod(minutes, 60)
    return f"{hour:02}:{minute:02}:{second:02},{fraction:03}"


def write_srt(path, cues):
    path.write_text("\n\n".join(f"{i}\n{srt_stamp(c['start'])} --> {srt_stamp(c['end'])}\n{c['text']}" for i, c in enumerate(cues, 1)), encoding="utf-8-sig")

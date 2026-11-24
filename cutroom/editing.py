"""Project settings shared by validation, previews and final rendering."""
import math
from typing import Literal

from pydantic import BaseModel, Field


MODES = ("main", "short", "crop")
MODE_LABELS = {"main": "가로 본편", "short": "쇼츠 전체 화면", "crop": "쇼츠 꽉 채우기"}
VERSION = 2
FPS = 24
FONTS = {"gothic": ("Malgun Gothic", -1), "serif": ("Batang", 0), "round": ("Gulim", 0)}
LOOKS = {
    "original": "",
    "warm": "colorbalance=rs=0.035:bs=-0.025:rm=0.025:bm=-0.018,eq=saturation=1.05",
    "clear": "eq=contrast=1.04:saturation=1.07",
    "mono": "hue=s=0,eq=contrast=1.04",
}
DEFAULTS = {"captions": True, "transition": True, "emphasis": True, "narration": False,
            "font": "gothic", "look": "original", "cropX": 50, "cropY": 50, "captionShift": 0.0}


class Interval(BaseModel):
    start: float = Field(ge=0, allow_inf_nan=False)
    end: float = Field(gt=0, allow_inf_nan=False)


class NewClip(Interval):
    id: str = Field(pattern=r"^custom-[a-zA-Z0-9-]{1,64}$")
    title: str = Field(default="직접 추가한 장면", min_length=1, max_length=120)


class CaptionEdit(Interval):
    text: str = Field(min_length=1, max_length=3000)
    skip: bool = False


class Revision(BaseModel):
    mode: Literal["main","short","crop"]
    ids: list[str]
    ranges: dict[str, Interval] = Field(default_factory=dict)
    custom: list[NewClip] = Field(default_factory=list)
    captionEdits: dict[str, CaptionEdit] = Field(default_factory=dict)
    addedCaptions: list[CaptionEdit] = Field(default_factory=list)
    captionShift: float = Field(default=0, ge=-60, le=60, allow_inf_nan=False)
    font: Literal["gothic","serif","round"] = "gothic"
    look: Literal["original","warm","clear","mono"] = "original"
    cropX: int = Field(default=50, ge=0, le=100)
    cropY: int = Field(default=50, ge=0, le=100)
    captions: bool = True
    transition: bool = True
    emphasis: bool = True
    narration: bool = False
    baseRevision: str | None = None


class Preview(Revision):
    at: float = Field(ge=0, allow_inf_nan=False)


def pool(clips, mode):
    return clips["main" if mode == "main" else "short"]


def settings_for(clips, has_text):
    return {**DEFAULTS, "ids":[c["id"] for c in clips if c["included"]], "captions":has_text, "emphasis":has_text,
            "ranges":{}, "custom":[], "captionEdits":{}, "addedCaptions":[]}


def selected_spans(clips, settings, duration):
    by_id = {c["id"]:c for c in clips}
    for extra in settings.get("custom",[]):
        if extra["id"] in by_id:
            raise ValueError("같은 장면이 두 번 추가됐어요.")
        by_id[extra["id"]] = extra
    ranges = settings.get("ranges", {})
    ids = set(settings["ids"])
    if not ids or not ids.issubset(by_id) or not ranges.keys() <= by_id.keys():
        raise ValueError("포함할 장면을 한 개 이상 선택해 주세요.")
    intervals = []
    for key, clip in by_id.items():
        interval = ranges.get(key, clip)
        a,b = interval["start"], interval["end"]
        if not (0 <= a < b <= duration + .001) or b-a < min(1/FPS, duration) - .001:
            raise ValueError("시작과 끝을 원본 안에서 한 프레임 이상 떨어지게 지정해 주세요.")
        if key in ids:
            intervals.append((a,min(b,duration)))
    spans = []
    for a,b in sorted(intervals):
        if spans and a <= spans[-1][1] + .0005:
            spans[-1][1] = max(spans[-1][1], b)
        else:
            spans.append([a,b])
    return spans


def frame_count(length):
    return max(1, math.floor(length*FPS + .5))


def edited_cues(cues, settings, duration):
    edits = settings.get("captionEdits", {})
    if edits.keys() - {str(i) for i in range(len(cues))}:
        raise ValueError("자막이 업데이트됐어요. 작업을 다시 열어 주세요.")
    shift = settings.get("captionShift",0)
    result = []
    additions = settings.get("addedCaptions", [])
    for i, original in enumerate([*cues, *additions]):
        cue = edits.get(str(i), original)
        a,b = cue["start"],cue["end"]
        if (str(i) in edits or i >= len(cues)) and (not 0 <= a < b <= duration+.001 or not cue["text"].strip()):
            raise ValueError("자막의 문장과 원본 시작·끝 시각을 확인해 주세요.")
        if cue.get("skip"):
            continue
        a,b = max(0,a+shift),min(duration,b+shift)
        if b>a:
            result.append({"start":a,"end":b,"text":cue["text"].strip()})
    return sorted(result,key=lambda c:c["start"])

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import media
from .editing import FPS, MODES, MODE_LABELS, VERSION, Preview, Revision, edited_cues, frame_count, pool as clip_pool, selected_spans, settings_for
from .planner import PLAN_VERSION, make_plan, parse_captions


BASE = media.ROOT
STORE = Path(os.environ.get("CUTROOM_DATA") or BASE/".local/jobs").resolve()
STORE.mkdir(parents=True, exist_ok=True)
DEMO = BASE/"assets/demo"
preview_slots = threading.BoundedSemaphore(2)
waveform_lock = threading.Lock()
editing_source_lock = threading.Lock()
recommendation_lock = threading.Lock()
EXTENSIONS = {".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi"}
CONTENT_TYPES = {".mp4":"video/mp4",".m4v":"video/mp4",".mov":"video/quicktime",".webm":"video/webm",".mkv":"video/x-matroska",".avi":"video/x-msvideo"}
mutex = threading.RLock()
worker = None
logger = logging.getLogger("uvicorn.error")


def location(key):
    if not re.fullmatch(r"[a-f0-9]{32}",key) or not (STORE/key/"job.json").is_file():
        raise HTTPException(404,"작업을 찾을 수 없어요.")
    return STORE/key


def read(folder):
    with mutex:
        return json.loads((folder/"job.json").read_text(encoding="utf-8"))


def save(folder,data):
    with mutex:
        pending = folder/"job.tmp"
        pending.write_text(json.dumps(data,ensure_ascii=False),encoding="utf-8")
        os.replace(pending,folder/"job.json")


def edit(folder, **changes):
    with mutex:
        job = read(folder)
        job.update(changes)
        save(folder,job)
        return job


def summary(job):
    return {k:job[k] for k in ("id","name","created","status","stage","progress","info","demo","poster","method","outputs") if k in job}


def new_job(name,demo=False):
    key = uuid.uuid4().hex
    folder = STORE/key
    folder.mkdir()
    job = {"id":key,"name":name,"demo":demo,"created":time.time(),"status":"queued","stage":"편집 대기","progress":1,
           "error":"","info":None,"poster":False,"method":"","clips":{},"outputs":{},"captionCount":0}
    return folder, job


def save_analysis(folder, cues, method, info, clips, planner_version, levels=None):
    temp = folder/"analysis.tmp"
    data = {"timingVersion":VERSION, "plannerVersion":planner_version, "cues":cues, "method":method,
            "info":info,"clips":clips}
    if levels is not None:
        data["levels"] = [round(value, 4) for value in levels]
    temp.write_text(json.dumps(data,ensure_ascii=False),encoding="utf-8")
    os.replace(temp,folder/"analysis.json")


def read_analysis(folder):
    return json.loads((folder/"analysis.json").read_text(encoding="utf-8"))


def process(folder, requested=None):
    job = read(folder)
    source = folder/"source"
    try:
        if not (folder/"analysis.json").exists():
            edit(folder,status="working",stage="원본 영상 확인",progress=3,error="")
            info = media.probe(source)
            if not info["width"] or not info["height"]:
                raise ValueError("화면이 들어 있는 영상 파일을 올려주세요.")
            media.thumbnail(source,folder/"poster.jpg",min(info["duration"]*.17,10))
            edit(folder,info=info,poster=True,stage="소리와 장면 분석",progress=9)
            audio, levels = media.get_signal(source,info,folder)
            try:
                if (folder/"captions.txt").is_file():
                    cues = parse_captions(folder/"captions.txt",info["duration"])
                    if not cues:
                        raise ValueError("자막의 시간 구간을 읽을 수 없어요. 유효한 SRT 또는 VTT 파일로 다시 올려주세요.")
                    method = "첨부 자막"
                else:
                    edit(folder,stage="한국어 대사 전사",progress=13)
                    latest = [-1]
                    def asr_progress(ratio,device):
                        progress = 13 + int(28 * min(1,ratio))
                        if progress != latest[0]:
                            edit(folder,stage="한국어 대사 전사 · " + device.upper(),progress=progress)
                            latest[0] = progress
                    cues,method = media.recognize(audio,info["duration"],asr_progress)
            finally:
                if audio:
                    audio.unlink(missing_ok=True)
            edit(folder,stage="하이라이트 구간 선택",progress=42)
            clips = {mode:make_plan(info["duration"],cues,levels,mode) for mode in ("main","short")}
            save_analysis(folder,cues,method,info,clips,PLAN_VERSION,levels)
        else:
            analysis = read_analysis(folder)
            cues,method,info,clips = (analysis[k] for k in ("cues","method","info","clips"))
            if analysis.get("timingVersion",0)<VERSION:
                if "displayRatio" not in info:
                    info = media.probe(source)
                if "Whisper" in method and info["audio"] and not (folder/"captions.txt").is_file():
                    edit(folder,status="working",stage="기존 자막과 발화 시각 다시 맞추는 중",progress=9)
                    audio = media.speech_audio(source,folder)
                    try:
                        fresh,engine = media.recognize(audio,info["duration"],lambda *_:None)
                        if not fresh and engine != "인식된 대사 없음":
                            raise ValueError("기존 자막을 다시 맞추려면 로컬 Whisper 연결을 확인하고 재시도해 주세요.")
                        cues,method = fresh,engine
                    finally:
                        audio.unlink(missing_ok=True)
                save_analysis(folder,cues,method,info,clips,analysis.get("plannerVersion",1),analysis.get("levels"))
        edit(folder,status="working",info=info,clips=clips,method=method,captionCount=len(cues),error="")
        tasks = []
        if requested:
            tasks.append(requested)
        else:
            for m in MODES:
                previous = job["outputs"].get(m,{})
                if previous.get("version",0) >= VERSION:
                    continue
                inherited = previous.get("settings", {})
                if m == "crop" and not previous:
                    fit = job["outputs"].get("short", {}).get("settings", {})
                    inherited = {key: value for key, value in fit.items() if key not in ("cropX", "cropY")}
                tasks.append((m,{**settings_for(clip_pool(clips,m),bool(cues)),**inherited}))
        for i,(mode,settings) in enumerate(tasks):
            extent = 90 if requested else 54/len(tasks)
            low = 5 if requested else 45+int(i*extent)
            stage = MODE_LABELS[mode] + " MP4 만드는 중"
            edit(folder,stage=stage,progress=low)
            result = media.render_output(folder,source,info,clip_pool(clips,mode),cues,mode,settings,
                                        lambda frac:edit(folder,progress=low+int(frac*extent)))
            with mutex:
                current = read(folder)
                current["outputs"][mode] = result
                save(folder,current)
        edit(folder,status="ready",stage="편집 완료",progress=100,error="")
    except Exception as exc:
        logger.exception("Editing job %s failed",folder.name)
        message = str(exc) if isinstance(exc,ValueError) else "영상 처리에 실패했어요. 파일을 재생할 수 있는지 확인하고 다시 시도해 주세요."
        previous = read(folder)["outputs"]
        ready = bool(requested) and bool(previous)
        edit(folder,status="ready" if ready else "failed",stage="이전 편집본 보관 중" if ready else "작업 중단",error=message,progress=100 if ready else 0)


@contextmanager
def exclusive_store():
    with (STORE/".owner.lock").open("a+b") as lock:
        if lock.tell()==0:
            lock.write(b"1")
            lock.flush()
        lock.seek(0)
        try:
            if os.name=="nt":
                import msvcrt
                msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError as exc:
            raise RuntimeError("이미 실행 중인 컷룸이 이 작업 폴더를 사용하고 있어요.") from exc
        yield


@asynccontextmanager
async def lifespan(app):
    global worker
    with exclusive_store(), ThreadPoolExecutor(max_workers=1,thread_name_prefix="cutroom") as pool:
        worker=pool
        try:
            for p in STORE.glob("*/job.json"):
                try:
                    existing = read(p.parent)
                    if existing["status"] in ("queued","working"):
                        edit(p.parent,status="failed",stage="작업 중단",error="앱을 다시 시작했어요. 이어서 편집할 수 있어요.")
                    elif existing["status"]=="ready" and any(existing["outputs"].get(m,{}).get("version",0)<VERSION for m in MODES):
                        edit(p.parent,status="queued",stage="편집본 업데이트 대기",progress=1,error="")
                        pool.submit(process,p.parent)
                except (OSError, ValueError, KeyError):
                    logger.warning("Unreadable job %s",p.parent.name)
            yield
        finally:
            worker=None


app = FastAPI(title="컷룸",docs_url=None,redoc_url=None,lifespan=lifespan)


@app.middleware("http")
async def restrict_writes(request: Request, call_next):
    origin = request.headers.get("origin")
    if request.method not in ("GET","HEAD","OPTIONS") and origin and origin.rstrip("/") != str(request.base_url).rstrip("/"):
        return JSONResponse({"detail":"이 작업 공간에서 다시 열어주세요."}, status_code=403)
    return await call_next(request)


@app.get("/api/config")
def config():
    return {"speech":bool(media.speech_tools()),"voice":media.voice_available(),"engine":bool(shutil.which(media.FFMPEG) and shutil.which(media.FFPROBE)),
            "demo":(DEMO/"lesson.mp4").is_file()}


@app.get("/api/jobs")
def list_jobs():
    result = []
    for entry in STORE.glob("*/job.json"):
        try:
            result.append(summary(read(entry.parent)))
        except (OSError,ValueError,KeyError):
            continue
    return sorted(result,key=lambda item:item["created"],reverse=True)


@app.post("/api/jobs",status_code=202)
def upload(video: UploadFile = File(...), captions: UploadFile | None = File(None)):
    name = (video.filename or "원본.mp4").replace("\\","/").rsplit("/",1)[-1][:180]
    if Path(name).suffix.lower() not in EXTENSIONS:
        raise HTTPException(422,"MP4, MOV, WebM, MKV, M4V 또는 AVI 영상을 선택해 주세요.")
    subtitle = None
    if captions and captions.filename:
        if Path(captions.filename).suffix.lower() not in (".srt",".vtt"):
            raise HTTPException(422,"자막은 SRT 또는 VTT 파일을 선택해 주세요.")
        subtitle = captions.file.read(8*1024*1024+1)
        if not subtitle or len(subtitle)>8*1024*1024:
            raise HTTPException(422,"자막은 8MB 이하의 비어 있지 않은 파일을 선택해 주세요.")
    free = shutil.disk_usage(STORE).free
    if video.size and video.size > free * .8:
        raise HTTPException(507,"원본과 편집본을 저장할 디스크 공간이 부족해요.")
    folder,job = new_job(name)
    try:
        with (folder/"source").open("wb") as dest:
            shutil.copyfileobj(video.file,dest,length=1024*1024)
        if (folder/"source").stat().st_size == 0:
            raise HTTPException(422,"영상 파일이 비어 있어요.")
        if subtitle:
            (folder/"captions.txt").write_bytes(subtitle)
        save(folder,job)
    except Exception:
        for filename in ("source","captions.txt","job.tmp"):
            (folder/filename).unlink(missing_ok=True)
        folder.rmdir()
        raise
    worker.submit(process,folder)
    return job


@app.post("/api/demo",status_code=202)
def demo():
    if not (DEMO/"lesson.mp4").is_file():
        raise HTTPException(404,"예시 수업 파일이 없어요.")
    folder,job = new_job("피자 한 조각으로 배우는 분수.mp4",True)
    shutil.copyfile(DEMO/"lesson.mp4",folder/"source")
    shutil.copyfile(DEMO/"lesson.srt",folder/"captions.txt")
    save(folder,job)
    worker.submit(process,folder)
    return job


@app.get("/api/jobs/{key}")
def detail(key:str):
    return read(location(key))


@app.get("/api/jobs/{key}/captions")
def original_captions(key:str):
    folder = location(key)
    if not (folder/"analysis.json").is_file():
        raise HTTPException(409,"자막을 준비하고 있어요.")
    data = read_analysis(folder)
    return {"cues":data["cues"],"version":data.get("timingVersion",0)}


@app.get("/api/jobs/{key}/recommendations")
def recommendations(key: str):
    folder = location(key)
    analysis_path = folder / "analysis.json"
    if not analysis_path.is_file():
        raise HTTPException(409, "원본 분석이 끝나면 추천을 비교할 수 있어요.")
    with recommendation_lock:
        stamp = analysis_path.stat().st_mtime_ns
        analysis = read_analysis(folder)
        if analysis.get("plannerVersion") == PLAN_VERSION:
            plans = analysis["clips"]
        else:
            cache = folder / f"recommendations-{PLAN_VERSION}.json"
            saved = json.loads(cache.read_text(encoding="utf-8")) if cache.is_file() else {}
            if saved.get("sourceStamp") == stamp:
                plans = saved["plans"]
            else:
                info, levels = analysis["info"], analysis.get("levels")
                if levels is None:
                    with tempfile.TemporaryDirectory(prefix="recommend-", dir=folder) as temp:
                        _, levels = media.get_signal(folder / "source", info, Path(temp))
                plans = {m: make_plan(info["duration"], analysis["cues"], levels, m) for m in ("main", "short")}
                pending = cache.with_suffix(".tmp")
                pending.write_text(json.dumps({"sourceStamp":stamp,"plans":plans},ensure_ascii=False),encoding="utf-8")
                os.replace(pending, cache)
    return {mode: [c for c in scenes if c["included"]] for mode, scenes in plans.items()}


@app.api_route("/api/jobs/{key}/editing-source", methods=["GET", "HEAD"])
def compatible_source(key: str):
    folder = location(key)
    info = read(folder)["info"]
    if not info:
        raise HTTPException(409, "원본 영상을 확인하고 있어요.")
    cached = folder / "editing-source.mp4"
    if not cached.is_file():
        with editing_source_lock:
            if not cached.is_file():
                with tempfile.TemporaryDirectory(prefix="editing-source-", dir=folder) as temp:
                    staged = Path(temp) / cached.name
                    try:
                        media.editing_source(folder / "source", staged, info)
                        os.replace(staged, cached)
                    except (OSError, RuntimeError) as exc:
                        logger.exception("Could not prepare editing video for %s", key)
                        raise HTTPException(422, "편집용 영상을 만들 수 없어요.") from exc
    return FileResponse(cached, media_type="video/mp4", headers={"Cache-Control": "private, max-age=86400"})


@app.get("/api/jobs/{key}/waveform")
def waveform(key: str):
    folder = location(key)
    info = read(folder)["info"]
    if not info or not (folder / "analysis.json").is_file():
        raise HTTPException(409, "원본 소리를 분석하고 있어요.")
    headers = {"X-Peaks-Per-Second": str(media.PEAKS_PER_SECOND), "Cache-Control": "private, max-age=86400"}
    if not info["audio"]:
        return Response(b"", media_type="application/octet-stream", headers=headers)
    path = folder / "waveform.bin"
    if not path.is_file():
        # Earlier projects already contain an analysis. Derive their waveform on first open.
        with waveform_lock:
            if not path.is_file():
                with tempfile.TemporaryDirectory(prefix="wave-", dir=folder) as temp:
                    scratch = Path(temp)
                    audio = media.speech_audio(folder / "source", scratch)
                    _, peaks = media.audio_envelope(audio)
                    staged = scratch / "waveform.bin"
                    staged.write_bytes(peaks)
                    os.replace(staged, path)
    return FileResponse(path, media_type="application/octet-stream", headers=headers)


def validate_change(job,change):
    settings = change.model_dump(exclude={"mode","at","baseRevision"})
    settings["ids"] = list(dict.fromkeys(settings["ids"]))
    settings["captions"] = change.captions and bool(job["captionCount"] or change.addedCaptions)
    spans = selected_spans(clip_pool(job["clips"],change.mode),settings,job["info"]["duration"])
    if change.mode!="main" and sum(frame_count(b-a) for a,b in spans)+(5*FPS if change.narration else 0)>60*FPS:
        raise ValueError("쇼츠의 포함 시간을 60초 이내로 줄여주세요. 도입 내레이션은 최대 5초를 사용해요.")
    return settings


@app.post("/api/jobs/{key}/preview")
def preview(key:str, change:Preview):
    folder = location(key)
    job = read(folder)
    if not job["info"] or not (folder/"analysis.json").is_file():
        raise HTTPException(409,"분석이 끝나면 장면을 확인할 수 있어요.")
    try:
        settings = validate_change(job,change)
        cues = edited_cues(read_analysis(folder)["cues"],settings,job["info"]["duration"])
    except ValueError as exc:
        raise HTTPException(422,str(exc)) from exc
    at = min(change.at,max(0,job["info"]["duration"]-.1))
    with preview_slots:
        image = media.preview_frame(folder/"source",change.mode,settings,at,cues)
    if not image:
        raise HTTPException(422,"이 위치에서 화면을 읽을 수 없어요. 조금 앞 장면을 선택해 주세요.")
    return Response(image,media_type="image/jpeg",headers={"Cache-Control":"no-store"})


@app.post("/api/jobs/{key}/render",status_code=202)
def revise(key:str, change:Revision):
    folder = location(key)
    with mutex:
        job = read(folder)
        if job["status"] != "ready":
            raise HTTPException(409,"현재 편집이 끝난 뒤에 적용할 수 있어요.")
        previous = job["outputs"].get(change.mode,{})
        revision = previous.get("editRevision") or previous.get("file","")
        if change.baseRevision is not None and change.baseRevision!=revision:
            raise HTTPException(409,"다른 창에서 편집본이 저장됐어요. 작업을 다시 열어 주세요.")
        try:
            settings = validate_change(job,change)
            edited_cues(read_analysis(folder)["cues"],settings,job["info"]["duration"])
        except ValueError as exc:
            raise HTTPException(422,str(exc)) from exc
        if previous.get("version")==VERSION and (folder/previous["file"]).is_file():
            saved = Revision(mode=change.mode, **previous["settings"]).model_dump(exclude={"mode","baseRevision"})
            layout = {"ids","ranges","custom"}
            same_effects = all(saved[k] == settings[k] for k in saved.keys() - layout)
            clips = clip_pool(job["clips"],change.mode)
            duration = job["info"]["duration"]
            if same_effects and selected_spans(clips,saved,duration) == selected_spans(clips,settings,duration):
                # Splitting a kept shot changes handles in the editor, not the rendered frames.
                job["outputs"][change.mode] = {**previous,"settings":settings,"editRevision":uuid.uuid4().hex}
                return edit(folder,outputs=job["outputs"],error="",stage="편집 완료")
        if change.narration and not media.voice_available():
            raise HTTPException(422,"이 PC에서 한국어 음성을 사용할 수 없어요.")
        result = edit(folder,status="queued",stage="변경 사항 적용 대기",progress=1,error="")
        worker.submit(process,folder,(change.mode,settings))
        return result


@app.post("/api/jobs/{key}/retry",status_code=202)
def retry(key:str):
    folder = location(key)
    with mutex:
        if read(folder)["status"]!="failed":
            raise HTTPException(409,"다시 시작할 작업이 없어요.")
        result = edit(folder,status="queued",stage="편집 재시도 대기",progress=1,error="")
        worker.submit(process,folder)
        return result


@app.api_route("/api/jobs/{key}/media/{asset}",methods=["GET","HEAD"])
def deliver(key:str,asset:str,download:bool=False):
    folder = location(key)
    job = read(folder)
    if asset == "source":
        kind = CONTENT_TYPES.get(Path(job["name"]).suffix.lower(),"application/octet-stream")
    elif asset == "poster.jpg":
        kind = "image/jpeg"
    elif re.fullmatch(r"(main|short|crop)-[a-f0-9]{12}\.(mp4|srt|jpg)",asset):
        kind = {".mp4":"video/mp4",".srt":"application/x-subrip",".jpg":"image/jpeg"}[Path(asset).suffix]
    else:
        raise HTTPException(404,"파일을 찾을 수 없어요.")
    path = folder/asset
    if not path.is_file():
        raise HTTPException(404,"아직 만들어지지 않은 파일이에요.")
    filename = None
    if download:
        suffix = Path(asset).suffix
        filename = Path(job["name"]).stem + "-" + MODE_LABELS.get(asset.split("-")[0],"원본") + suffix
    return FileResponse(path,media_type=kind,filename=filename,content_disposition_type="attachment" if download else "inline")


@app.get("/demo-poster.jpg")
def demo_poster():
    return FileResponse(DEMO/"poster.jpg",media_type="image/jpeg")


app.mount("/",StaticFiles(directory=BASE/"web",html=True),name="studio")

from __future__ import annotations

import importlib.util
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
import wave
from pathlib import Path

import numpy as np

from .planner import clean_line, cue_weight, write_srt
from .editing import DEFAULTS, FONTS, FPS, LOOKS, VERSION, edited_cues, frame_count, selected_spans


ROOT = Path(__file__).resolve().parent.parent
FFMPEG = os.environ.get("CUTROOM_FFMPEG") or shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = os.environ.get("CUTROOM_FFPROBE") or shutil.which("ffprobe") or "ffprobe"
FLAGS = {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
ALLOWED = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,asf,mpeg,mpegts,ogg,wav,mp3,aac,flac"
SAFE_INPUT = ["-protocol_whitelist", "file,pipe", "-format_whitelist", ALLOWED]
PEAKS_PER_SECOND = 50


def run(args, *, cwd=None, timeout=None):
    process = subprocess.run([str(x) for x in args], cwd=cwd, capture_output=True, timeout=timeout, **FLAGS)
    if process.returncode:
        raise RuntimeError(process.stderr.decode("utf-8", "replace")[-1300:] or "미디어 도구 실행 오류")
    return process.stdout


def ff(args, cwd=None):
    return run([FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-filter_complex_threads", "2", "-filter_threads", "2", *args], cwd=cwd)


def probe(path):
    result = json.loads(run([FFPROBE, "-v", "error", *SAFE_INPUT, "-show_streams", "-show_format", "-of", "json", path], timeout=45))
    streams = result.get("streams", [])
    video = next((s for s in streams if s["codec_type"] == "video" and not s.get("disposition", {}).get("attached_pic")), {})
    duration = float(result.get("format", {}).get("duration") or video.get("duration") or 0)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("재생 시간을 확인할 수 없는 파일입니다.")
    ratio = video.get("width",0) / max(video.get("height",0),1)
    sar = str(video.get("sample_aspect_ratio","")).split(":")
    if len(sar)==2 and all(n.isdigit() and int(n)>0 for n in sar):
        ratio *= int(sar[0])/int(sar[1])
    rotation = next((float(d["rotation"]) for d in video.get("side_data_list",[]) if "rotation" in d),0)
    if ratio and round(rotation/90)%2:
        ratio = 1/ratio
    return {"duration": duration, "width": video.get("width", 0), "height": video.get("height", 0),"displayRatio":ratio,
            "audio": any(s["codec_type"] == "audio" for s in streams)}


def speech_tools():
    interpreter = os.environ.get("CUTROOM_WHISPER_PYTHON")
    if not interpreter and importlib.util.find_spec("faster_whisper"):
        interpreter = sys.executable
    if not interpreter:
        for name in (ROOT / ".venv", ROOT.parent / "vtranscript" / ".venv"):
            path = name / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
            installed = (name / "Lib/site-packages/faster_whisper").is_dir() if os.name == "nt" else any(name.glob("lib/python*/site-packages/faster_whisper"))
            if path.is_file() and installed:
                interpreter = str(path)
                break
    model = os.environ.get("CUTROOM_WHISPER_MODEL")
    if not model:
        hub = Path(os.environ.get("HF_HUB_CACHE") or Path(os.environ.get("HF_HOME") or Path.home() / ".cache/huggingface") / "hub")
        for size in ("small", "medium", "base", "large-v3", "tiny"):
            files = list((hub / f"models--Systran--faster-whisper-{size}" / "snapshots").glob("*/model.bin"))
            if files:
                model = str(files[0].parent)
                break
    return (str(interpreter), str(model)) if interpreter and Path(interpreter).is_file() and model and Path(model, "model.bin").is_file() else None


def voice_available():
    if os.name != "nt":
        return False
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Speech\Voices\Tokens") as tokens:
            for i in range(winreg.QueryInfoKey(tokens)[0]):
                with winreg.OpenKey(tokens, winreg.EnumKey(tokens, i) + r"\Attributes") as attr:
                    if "412" in winreg.QueryValueEx(attr, "Language")[0].lower().split(";"):
                        return True
    except OSError:
        pass
    return False


def thumbnail(source, destination, ts):
    ff(["-ss", str(ts), *SAFE_INPUT, "-i", source, "-frames:v", "1", "-vf", "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2", "-q:v", "3", destination])


def editing_source(source, destination, info):
    edge = max(2, min(960, max(info["width"], info["height"])))
    picture = (f"fps={FPS}:start_time=0,scale={edge}:{edge}:force_original_aspect_ratio=decrease:"
               "force_divisible_by=2:reset_sar=1,setsar=1,format=yuv420p")
    sound = (["-map", "0:a:0", "-af", "aresample=48000:async=1:first_pts=0", "-c:a", "aac",
              "-ar", "48000", "-ac", "2", "-b:a", "96k"] if info["audio"] else ["-an"])
    ff([*SAFE_INPUT, "-i", source, "-map", "0:V:0", *sound, "-vf", picture,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-threads", "4",
        "-g", str(FPS), "-movflags", "+faststart", destination])


def speech_audio(source, folder):
    audio = folder / "speech.wav"
    ff([*SAFE_INPUT, "-i", source, "-map", "0:a:0", "-af", "aresample=16000:async=1:first_pts=0",
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audio])
    return audio


def audio_envelope(audio):
    levels = []
    peaks = bytearray()
    with wave.open(str(audio)) as stream:
        rate = stream.getframerate()
        block = rate // PEAKS_PER_SECOND
        while samples := stream.readframes(rate):
            values = np.frombuffer(samples, dtype="<i2").astype(np.float32)
            levels.append(float(np.sqrt(np.mean(values * values))))
            values = np.pad(values, (0, -len(values) % block))
            peak = np.abs(values).reshape(-1, block).max(axis=1)
            peaks.extend((255 * np.sqrt(peak / 32768)).astype(np.uint8).tobytes())
    return levels, peaks


def get_signal(source, info, folder):
    if info["audio"]:
        audio = speech_audio(source, folder)
        levels, peaks = audio_envelope(audio)
        (folder / "waveform.bin").write_bytes(peaks)
        if not levels or max(levels) < 35:
            levels = visual_levels(source)
    else:
        audio = None
        levels = visual_levels(source)
    norm = float(np.percentile(levels, 85)) if levels else 1
    return audio, [min(1.8, x / max(norm, 1)) for x in levels]


def visual_levels(source):
    data = ff([*SAFE_INPUT, "-i", source, "-an", "-vf", "fps=1,scale=64:36,format=gray", "-f", "rawvideo", "pipe:1"])
    frames = np.frombuffer(data, dtype=np.uint8).reshape(-1, 64 * 36)
    return [0.0] + [float(np.mean(np.abs(frames[i].astype(np.int16) - frames[i-1]))) for i in range(1, len(frames))]


def align_quiet_edges(audio, cues):
    """Only tighten clearly quiet leading/trailing regions of automatic word groups."""
    with wave.open(str(audio)) as stream:
        rate = stream.getframerate()
        step = rate // 100
        for cue in cues:
            first = min(stream.getnframes(), max(0, int(cue["start"]*rate)))
            stream.setpos(first)
            samples = np.frombuffer(stream.readframes(max(0,int(cue["end"]*rate)-first)),dtype="<i2")
            n = len(samples)//step
            if n < 12:
                continue
            blocks = samples[:n*step].astype(np.float32).reshape(n,step)
            power = np.sqrt(np.mean(blocks*blocks,axis=1))
            gate = max(15.0,float(np.percentile(power,90))*.055)
            active = np.flatnonzero(np.convolve((power>gate).astype(int),np.ones(3,dtype=int),"valid")>=2)
            if not len(active):
                continue
            start,end = cue["start"],cue["end"]
            if active[0]>=12:
                start = round((first+max(0,int(active[0])-3)*step)/rate,3)
            if n-active[-1]>=15:
                end = round((first+min(n,int(active[-1])+6)*step)/rate,3)
            if end-start>=.10:
                cue.update(start=start,end=end)
    return cues


def recognize(audio, duration, on_progress):
    local = speech_tools()
    if not local or not audio:
        return [], "음성 인식 모델 없음" if audio else "무음 영상"
    interpreter, model = local
    preferred = os.environ.get("CUTROOM_ASR_DEVICE", "auto")
    devices = (["cuda", "cpu"] if shutil.which("nvidia-smi") else ["cpu"]) if preferred == "auto" else [preferred]
    error = ""
    for device in devices:
        cues = []
        with tempfile.TemporaryFile() as log:
            with subprocess.Popen([interpreter, "-X", "utf8", str(ROOT / "cutroom/transcribe.py"), model, str(audio), device],
                                  stdout=subprocess.PIPE, stderr=log, text=True, encoding="utf-8", **FLAGS) as worker:
                for line in worker.stdout:
                    cue = json.loads(line)
                    if cue["start"] < duration and cue["end"] > cue["start"]:
                        cue["end"] = min(duration, cue["end"])
                        cues.append(cue)
                        on_progress(cue["end"] / duration, device)
                if worker.wait() == 0:
                    return align_quiet_edges(audio,cues), ("로컬 Whisper · " + device.upper()) if cues else "인식된 대사 없음"
                log.seek(0)
                error = log.read().decode("utf-8", "replace")[-500:]
    print("Speech recognition unavailable:", error, file=sys.stderr, flush=True)
    return [], "전사 실패 · 영상 신호 분석"


def time_ass(t):
    cs = max(0, round(t * 100))
    minutes, sec = divmod(cs // 100, 60)
    return f"{minutes//60}:{minutes%60:02}:{sec:02}.{cs%100:02}"


def write_ass(path, cues, width, height, settings):
    face, bold = FONTS[settings.get("font","gothic")]
    fontsize = 46 if height > width else 39
    margin = 195 if height > width else 46
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Base,{face},{fontsize},&H00FFFFFF,&H000000FF,&H00201814,&H60000000,{bold},0,0,0,100,100,0,0,1,3,1,2,38,38,{margin},1
[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
"""
    events = []
    for c in cues:
        value = r"\N".join(c["text"].replace("\\", " ").replace("{","(").replace("}",")").splitlines())
        if settings["emphasis"] and cue_weight(value) >= 2:
            value = r"{\c&H9BF7CB&}" + value
        events.append(f"Dialogue: 0,{time_ass(c['start'])},{time_ass(c['end'])},Base,,0,0,0,,{value}")
    path.write_text(header + "\n".join(events), encoding="utf-8-sig")


def relative_cues(cues, start, end):
    return [{"start": max(0, c["start"] - start), "end": min(end, c["end"]) - start, "text": c["text"]}
            for c in cues if min(end,c["end"]) - max(start,c["start"]) >= .01]


def dimensions(mode):
    return (1280, 720) if mode == "main" else (720, 1280)


def video_graph(mode, settings, clock, scratch, cues, fades=()):
    width, height = dimensions(mode)
    graph = "[0:v:0]" + clock + ","
    if mode == "crop":
        x = settings.get("cropX", 50) / 100
        y = settings.get("cropY", 50) / 100
        graph += ("scale=720:1280:force_original_aspect_ratio=increase:force_divisible_by=2:reset_sar=1,"
                  f"crop=720:1280:(iw-ow)*{x:.4f}:(ih-oh)*{y:.4f}:exact=1,setsar=1")
    elif mode == "short":
        graph += ("split=2[bg][fg];[bg]scale=144:256:force_original_aspect_ratio=increase:reset_sar=1,"
                  "crop=144:256,boxblur=5:1,eq=brightness=-0.16,scale=720:1280[b];"
                  "[fg]scale=720:1280:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1[f];"
                  "[b][f]overlay=(W-w)/2:(H-h)/2,setsar=1")
    else:
        graph += ("scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1,"
                  "pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1")
    filters = [LOOKS[settings.get("look","original")], *fades]
    if settings["captions"] and cues:
        write_ass(scratch/"captions.ass", cues, width, height, settings)
        filters.append("ass=filename=captions.ass")
    return graph + "".join("," + item for item in filters if item) + ",format=yuv420p[v]"


def preview_frame(source, mode, settings, at, cues):
    # A preview represents this exact source instant using the same filters as the export.
    active = [{**c, "start":0, "end":1} for c in cues if c["start"] <= at < c["end"]]
    with tempfile.TemporaryDirectory(prefix="cutroom-preview-") as tmp:
        graph = video_graph(mode, settings, "setpts=PTS-STARTPTS", Path(tmp), active)
        return ff(["-ss", f"{at:.6f}", *SAFE_INPUT, "-i", source, "-filter_complex", graph,
                   "-map","[v]", "-frames:v","1", "-q:v","3", "-c:v","mjpeg","-f","image2pipe","pipe:1"],cwd=tmp)


def render_part(source, info, start, frames, mode, settings, cue_list, scratch, file_name, voice=None, boundary=(False,False)):
    length = frames / FPS
    if voice:
        inputs = ["-loop","1","-framerate",str(FPS),"-i",source,"-i",voice]
        audio_id = "1:a:0"
    else:
        inputs = ["-ss", f"{start:.6f}", *SAFE_INPUT, "-i", source]
        audio_id = "0:a:0"
        if not info["audio"]:
            inputs += ["-f","lavfi","-i","anullsrc=r=48000:cl=stereo"]
            audio_id = "1:a:0"
    fades = []
    if settings["transition"] and length > .6:
        if boundary[0]:
            fades.append("fade=t=in:d=0.16")
        if boundary[1]:
            fades.append(f"fade=t=out:st={length-.16:.6f}:d=0.16")
    clock = f"fps={FPS}:start_time=0,tpad=stop_mode=clone:stop_duration={length:.6f},trim=end_frame={frames},setpts=N/({FPS}*TB)"
    graph = video_graph(mode, settings, clock, scratch, cue_list, fades)
    samples = frames * (48000 // FPS)
    # Keep audio sample-exact through the cuts. AAC is encoded once on the final timeline.
    ff([*inputs, "-filter_complex",graph, "-map","[v]", "-map",audio_id,
        "-af",f"aresample=48000:async=1:first_pts=0,apad,atrim=end_sample={samples},asetpts=N/SR/TB",
        "-t",f"{length:.9f}","-c:v","libx264","-preset","veryfast","-crf","23","-threads","4",
        "-c:a","pcm_s16le","-ar","48000","-ac","2","-video_track_timescale","24000",file_name],cwd=scratch)


def render_output(folder, source, info, clips, cues, mode, settings, on_progress):
    settings = {**DEFAULTS, **settings}
    spans = selected_spans(clips,settings,info["duration"])
    cues = edited_cues(cues,settings,info["duration"])
    revision = uuid.uuid4().hex[:12]
    name = f"{mode}-{revision}"
    with tempfile.TemporaryDirectory(prefix="render-", dir=folder) as tmp:
        scratch = Path(tmp)
        segment_files, timeline, final_cues = [], [], []
        cursor = 0
        if settings["narration"]:
            if not voice_available():
                raise ValueError("이 PC에서 한국어 내레이션 음성을 찾을 수 없어요.")
            line = next((clean_line(c["text"]) for c in relative_cues(cues,*spans[0]) if 5 <= len(clean_line(c["text"])) <= 27 and "?" in c["text"]), "이 장면을 함께 볼까요?")
            (scratch / "voice.txt").write_text(line, encoding="utf-8")
            voice = scratch / "intro.wav"
            run(["powershell.exe","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",ROOT/"cutroom/narrate.ps1",scratch/"voice.txt",voice],timeout=30)
            offset = probe(voice)["duration"]
            if offset > 5:
                (scratch / "voice.txt").write_text("이 장면을 함께 볼까요?", encoding="utf-8")
                line = "이 장면을 함께 볼까요?"
                run(["powershell.exe","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",ROOT/"cutroom/narrate.ps1",scratch/"voice.txt",voice], timeout=30)
                offset = probe(voice)["duration"]
            ff(["-ss",str(spans[0][0]),*SAFE_INPUT,"-i",source,"-frames:v","1","-vf","scale=-2:ih:reset_sar=1","-q:v","2",scratch/"intro.jpg"])
            cursor = max(1,math.ceil(offset*FPS))
            intro_cues = [{"start":0,"end":min(offset,cursor/FPS),"text":"내레이션 · " + line}]
            render_part(scratch/"intro.jpg", info, 0, cursor, mode, settings, intro_cues, scratch, "intro.mov",voice=voice)
            segment_files.append(("intro.mov",cursor))
            timeline.append({"at":0, "end":cursor/FPS, "source":spans[0][0], "intro":True})
            final_cues.extend(intro_cues)
        if mode != "main" and cursor + sum(frame_count(b-a) for a,b in spans) > 60*FPS:
            raise ValueError("내레이션을 포함해 1분 안에 들어오도록 구간을 줄여주세요.")
        for index, (a,b) in enumerate(spans):
            frames = frame_count(b-a)
            local_cues = relative_cues(cues,a,min(b,a+frames/FPS))
            part = f"part-{index}.mov"
            render_part(source,info,a,frames,mode,settings,local_cues,scratch,part,boundary=(len(spans)==1 or index>0 or settings["narration"],index<len(spans)-1))
            offset = cursor / FPS
            cursor += frames
            timeline.append({"at":offset,"end":cursor/FPS,"source":a})
            final_cues.extend({**c,"start":c["start"]+offset,"end":c["end"]+offset} for c in local_cues)
            segment_files.append((part,frames))
            on_progress((index+1)/len(spans))
        (scratch/"parts.txt").write_text("\n".join(f"file '{f}'\nduration {n/FPS:.9f}" for f,n in segment_files),encoding="ascii")
        ff(["-f","concat","-safe","1","-i","parts.txt","-map","0:v:0","-map","0:a:0","-c:v","copy",
            "-c:a","aac","-b:a","112k","-t",f"{cursor/FPS:.9f}","-movflags","+faststart","finished.mp4"],cwd=scratch)
        result_info = probe(scratch/"finished.mp4")
        preview_time = min(result_info["duration"]*.4,1.0)
        ff(["-ss",str(preview_time),"-i","finished.mp4","-frames:v","1","-vf","scale=640:640:force_original_aspect_ratio=decrease:force_divisible_by=2",
            "-q:v","3",folder/(name+".jpg")],cwd=scratch)
        if final_cues:
            write_srt(folder/(name+".srt"), final_cues)
        os.replace(scratch/"finished.mp4",folder/(name+".mp4"))
    return {"version":VERSION,"file": name+".mp4", "poster":name+".jpg","srt": name+".srt" if final_cues else None, "duration": result_info["duration"],
            "width":result_info["width"],"height":result_info["height"],"timeline":timeline,"settings":settings}

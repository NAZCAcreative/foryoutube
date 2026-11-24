"""Runs in an interpreter with faster-whisper installed. Emits one JSON object per line."""
import json
import os
import sys

from faster_whisper import WhisperModel


def phrases(segment):
    words = [w for w in (segment.words or []) if w.word.strip() and w.end > w.start]
    if not words:
        if segment.text.strip() and segment.end > segment.start:
            yield segment.start, segment.end, segment.text.strip()
        return
    group = []
    for word in words:
        if group and (word.start-group[-1].end >= .55 or word.end-group[0].start > 3.8
                      or sum(len(w.word) for w in group)+len(word.word)>36):
            yield group[0].start, group[-1].end, "".join(w.word for w in group).strip()
            group = []
        group.append(word)
        if word.word.rstrip().endswith((".", "?", "!", "。", "？", "！")):
            yield group[0].start, group[-1].end, "".join(w.word for w in group).strip()
            group = []
    if group:
        yield group[0].start, group[-1].end, "".join(w.word for w in group).strip()


def transcribe():
    model_dir, source, device = sys.argv[1:4]
    engine = WhisperModel(model_dir, device=device, compute_type="float16" if device == "cuda" else "int8",
                          cpu_threads=min(8, os.cpu_count() or 2), local_files_only=True)
    segments, _ = engine.transcribe(source, language="ko", beam_size=2, vad_filter=True,
                                    condition_on_previous_text=False, word_timestamps=True)
    for line in segments:
        for a,b,text in phrases(line):
            print(json.dumps({"start": round(a, 3), "end": round(b, 3), "text": text}), flush=True)


if __name__ == "__main__":
    transcribe()

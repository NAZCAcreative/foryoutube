"""Exercise the upload, renderer, captions and downloads in a temporary workspace."""
import argparse
import os
import tempfile
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--long",action="store_true",help="also test a synthetic 50-minute recording")
    parser.add_argument("--speech",action="store_true",help="also upload the demo without its SRT and verify Whisper output")
    parser.add_argument("--voice",action="store_true",help="also render a Korean narration revision")
    options = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="cutroom-smoke-") as temp:
        scratch = Path(temp)
        os.environ["CUTROOM_DATA"] = str(scratch/"jobs")
        from fastapi.testclient import TestClient
        from cutroom import media,server
        from cutroom.planner import parse_captions,write_srt

        def wait(client, job):
            end = time.monotonic()+1800
            last = None
            while time.monotonic()<end:
                data = client.get("/api/jobs/"+job["id"]).json()
                if data["stage"]!=last:
                    print(data["stage"],flush=True)
                    last=data["stage"]
                if data["error"] or data["status"]=="failed":
                    raise RuntimeError(data["error"])
                if data["status"]=="ready":
                    return data
                time.sleep(.6)
            raise TimeoutError("Editing exceeded 30 minutes.")

        def check(client, job, subtitles=True):
            for mode in ("main","short","crop"):
                output=job["outputs"][mode]
                path=server.STORE/job["id"]/output["file"]
                actual=media.probe(path)
                assert actual["audio"] and actual["duration"]>0
                assert (actual["width"],actual["height"]) == ((1280,720) if mode=="main" else (720,1280))
                if mode!="main": assert actual["duration"]<=60.01
                url="/api/jobs/"+job["id"]+"/media/"+output["file"]
                assert client.get(url,headers={"Range":"bytes=0-31"}).status_code==206
                assert "attachment" in client.head(url+"?download=true").headers["content-disposition"]
                if subtitles:
                    assert output["srt"] and parse_captions(path.with_suffix(".srt"),actual["duration"])
                else:
                    assert not output["srt"]
                assert (path.parent/output["poster"]).is_file()
                print(mode,round(actual["duration"],2),"s",output["width"],"x",output["height"],flush=True)

        def check_split_save(client, job):
            api = "/api/jobs/" + job["id"]
            outputs = job["outputs"]
            main = outputs["main"]
            settings = main["settings"]
            clip = next(c for c in reversed(job["clips"]["main"]) if c["id"] in settings["ids"] and c["end"]-c["start"]>6)
            a = round(clip["start"]+2,3)
            b = round(a+2,3)
            middle = {"id":"custom-middle","title":"중간 조각","start":a,"end":b}
            last = {"id":"custom-last","title":"뒤 조각","start":b,"end":clip["end"]}
            split = {**settings,"mode":"main","baseRevision":main.get("editRevision",main["file"]),
                     "ids":[*settings["ids"],middle["id"],last["id"]],
                     "ranges":{**settings["ranges"],clip["id"]:{"start":clip["start"],"end":a}},
                     "custom":[*settings["custom"],middle,last]}
            start = time.monotonic()
            response = client.post(api+"/render",json=split)
            assert response.status_code==202 and response.json()["status"]=="ready"
            saved = client.get(api).json()["outputs"]["main"]
            assert (saved["file"],saved["srt"])==(main["file"],main["srt"]) and saved["editRevision"]!=split["baseRevision"]
            elapsed = time.monotonic()-start
            assert client.post(api+"/render",json=split).status_code==409
            removed = {**split,"ids":[key for key in split["ids"] if key!=middle["id"]],"baseRevision":saved["editRevision"]}
            assert client.post(api+"/render",json=removed).status_code==202
            after = wait(client,job)["outputs"]
            assert all(after[key]["file"]==outputs[key]["file"] for key in ("short","crop"))
            def content_frames(result):
                return sum(round((c["end"]-c["at"])*24) for c in result["timeline"] if not c.get("intro"))
            assert content_frames(main)-content_frames(after["main"])==48
            assert client.get(api+"/media/"+after["main"]["file"],headers={"Range":"bytes=0-31"}).status_code==206
            print("source",round(job["info"]["duration"]),"s / split-only save",round(elapsed*1000),"ms / removed 48 frames",flush=True)

        def check_editing_source(client, job):
            url = "/api/jobs/" + job["id"] + "/editing-source"
            folder = server.STORE / job["id"]
            proxy = folder / "editing-source.mp4"
            source_stamp = (folder / "source").stat().st_mtime_ns
            assert not proxy.exists()
            response = client.get(url, headers={"Range": "bytes=0-31"})
            assert response.status_code == 206 and len(response.content) == 32
            stamp = proxy.stat().st_mtime_ns
            assert client.head(url).headers["content-type"] == "video/mp4" and proxy.stat().st_mtime_ns == stamp
            actual, original = media.probe(proxy), job["info"]
            assert actual["audio"] == original["audio"] and abs(actual["duration"]-original["duration"]) < .05
            assert abs(actual["displayRatio"]-original["displayRatio"]) < .01
            assert max(actual["width"], actual["height"]) <= 960
            assert media.run([media.FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
                              "stream=codec_name", "-of", "csv=p=0", proxy]).strip() == b"h264"
            assert (folder / "source").stat().st_mtime_ns == source_stamp

        with TestClient(server.app) as client:
            assert client.get("/").status_code==200
            job=wait(client,client.post("/api/demo").json())
            check(client,job)
            recommendation_url = "/api/jobs/" + job["id"] + "/recommendations"
            plan = client.get(recommendation_url).json()
            assert plan["main"] == [s for s in job["clips"]["main"] if s["included"]]
            assert plan["short"] == [s for s in job["clips"]["short"] if s["included"]]
            folder = server.STORE / job["id"]
            analysis = server.read_analysis(folder)
            server.save_analysis(folder, analysis["cues"], analysis["method"], analysis["info"], analysis["clips"], 1)
            legacy = client.get(recommendation_url).json()
            assert legacy == plan
            cached = folder / f"recommendations-{server.PLAN_VERSION}.json"
            cached_at = cached.stat().st_mtime_ns
            assert client.get(recommendation_url).json() == legacy and cached.stat().st_mtime_ns == cached_at
            assert server.read(folder)["outputs"] == job["outputs"]
            check_editing_source(client,job)
            old=job["outputs"]["main"]
            chosen=list(old["settings"]["ids"])
            extras=[c["id"] for c in job["clips"]["main"] if c["id"] not in chosen]
            assert extras
            change={**old["settings"],"mode":"main","ids":chosen+extras[:2],"transition":False,"narration":options.voice}
            url="/api/jobs/"+job["id"]+"/render"
            assert client.post(url,json={**change,"ids":[]}).status_code==422
            assert client.post(url,json=change).status_code==202
            job=wait(client,job)
            check(client,job)
            assert job["outputs"]["main"]["duration"]>old["duration"]
            assert bool(job["outputs"]["main"]["timeline"][0].get("intro"))==options.voice
            api = "/api/jobs/" + job["id"]
            waveform = client.get(api + "/waveform")
            assert waveform.status_code == 200 and int(waveform.headers["X-Peaks-Per-Second"]) == 50
            assert len(waveform.content) >= int(job["info"]["duration"] - 1) * 50 and max(waveform.content) > 0
            index = 1
            cue = client.get(api + "/captions").json()["cues"][index]
            a, b = cue["start"] - .2, cue["end"] + .4
            addition = {"id":"custom-smoke","start":a,"end":b,"title":"직접 조절한 장면"}
            previous = job["outputs"]
            change = {**previous["crop"]["settings"], "mode":"crop", "ids":[addition["id"]], "custom":[addition],
                      "baseRevision":previous["crop"]["file"], "font":"serif","look":"mono","cropX":25,"captionShift":.125,
                      "captionEdits":{str(index):{**cue,"text":"수정한 대사"}}}
            preview = client.post(api + "/preview", json={**change,"at":a+.5})
            assert preview.status_code == 200 and preview.content.startswith(b"\xff\xd8")
            assert client.post(url,json={**change,"baseRevision":"old"}).status_code==409
            assert client.post(url,json={**change,"ranges":{addition["id"]:{"start":b,"end":a}}}).status_code==422
            assert client.post(url,json=change).status_code==202
            job=wait(client,job)
            crop=job["outputs"]["crop"]
            assert crop["file"] != previous["crop"]["file"] and crop["settings"]["cropX"]==25
            assert all(job["outputs"][key]["file"]==previous[key]["file"] for key in ("short","main"))
            revised=parse_captions(server.STORE/job["id"]/crop["srt"],crop["duration"])
            line=next(c for c in revised if c["text"]=="수정한 대사")
            assert abs(line["start"]-.325)<.001
            assert client.head(api+"/media/"+previous["crop"]["file"]).status_code == 200
            check_split_save(client,job)
            silent=scratch/"portrait.avi"
            media.ff(["-f","lavfi","-i","testsrc2=size=96x160:rate=12","-t","4","-c:v","ffv1",silent])
            with silent.open("rb") as video:
                posted=client.post("/api/jobs",files={"video":("silent.avi",video,"video/x-msvideo")})
            silent_job=wait(client,posted.json())
            assert silent_job["captionCount"]==0 and not silent_job["info"]["audio"]
            check(client,silent_job,subtitles=False)
            check_editing_source(client,silent_job)
            assert client.get("/api/jobs/"+silent_job["id"]+"/waveform").content == b""
            silent_api = "/api/jobs/" + silent_job["id"]
            manual = {**silent_job["outputs"]["main"]["settings"],"mode":"main","captions":True,
                      "addedCaptions":[{"start":.5,"end":1.5,"text":"직접 쓴 자막"}]}
            assert client.post(silent_api+"/render",json=manual).status_code == 202
            result = wait(client,silent_job)["outputs"]["main"]
            assert result["settings"]["captions"] and "직접 쓴 자막" in client.get(silent_api+"/media/"+result["srt"]).text
            if options.speech:
                with (server.DEMO/"lesson.mp4").open("rb") as video:
                    posted=client.post("/api/jobs",files={"video":("recording.mp4",video,"video/mp4")})
                assert posted.status_code==202
                spoken=wait(client,posted.json())
                assert "Whisper" in spoken["method"] and spoken["captionCount"]>1,spoken["method"]
                check(client,spoken)
                print("ASR",spoken["method"],spoken["captionCount"],"cues",flush=True)
            if options.long:
                original=server.DEMO/"lesson.mp4"
                length=media.probe(original)["duration"]
                long_video=scratch/"lecture.mp4"
                media.ff(["-stream_loop","-1","-i",original,"-t","3000","-c","copy","-movflags","+faststart",long_video])
                cues=parse_captions(original.with_suffix(".srt"),length)
                repeated=[]
                for loop in range(int(3000/length)+1):
                    for cue in cues:
                        start=loop*length+cue["start"]
                        if start<3000:
                            repeated.append({**cue,"start":start,"end":min(3000,loop*length+cue["end"])})
                subtitle=scratch/"lecture.srt"
                write_srt(subtitle,repeated)
                with long_video.open("rb") as vid, subtitle.open("rb") as sub:
                    posted=client.post("/api/jobs",files={"video":("lecture.mp4",vid,"video/mp4"),"captions":("lecture.srt",sub,"text/plain")})
                assert posted.status_code==202
                long_job=wait(client,posted.json())
                check(client,long_job)
                assert 300<=long_job["outputs"]["main"]["duration"]<=600
                check_split_save(client,long_job)
            print("Smoke checks passed.",flush=True)


if __name__=="__main__":
    main()

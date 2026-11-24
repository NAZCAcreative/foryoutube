import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

from cutroom import media
from cutroom.editing import DEFAULTS, edited_cues, selected_spans
from cutroom.planner import parse_captions


class EditingRevisionTests(unittest.TestCase):
    def test_portrait_fill_centers_landscape_in_preview_and_mp4(self):
        with tempfile.TemporaryDirectory(prefix="cutroom-center-") as tmp:
            folder = Path(tmp)
            source = folder / "markers.mp4"
            markers = ("color=c=black:s=320x180:r=24:d=1,"
                       "drawbox=x=0:y=0:w=100:h=180:c=red:t=fill,"
                       "drawbox=x=220:y=0:w=100:h=180:c=blue:t=fill,"
                       "drawbox=x=154:y=84:w=12:h=12:c=white:t=fill")
            media.ff(["-f","lavfi","-i",markers,"-c:v","libx264",source])
            clip = {"id":"one","start":0,"end":1}
            settings = {"ids":["one"], "captions":False, "transition":False}
            output = media.render_output(folder, source, media.probe(source), [clip], [],
                                         "crop", settings, lambda _:None)
            self.assertEqual((output["width"], output["height"]), (720,1280))
            still = folder / "preview.jpg"
            still.write_bytes(media.preview_frame(source, "crop", settings, .5, []))
            for asset in (still, folder / output["file"]):
                with self.subTest(asset=asset.suffix):
                    raw = media.ff(["-i",asset,"-frames:v","1","-vf","scale=180:320,format=rgb24",
                                    "-f","rawvideo","pipe:1"])
                    pixels = np.frombuffer(raw,np.uint8).reshape(320,180,3)
                    y,x = np.where(pixels.min(axis=2)>185)
                    np.testing.assert_allclose([x.mean(),y.mean()], [89.5,159.5], atol=1)
                    np.testing.assert_allclose([np.ptp(x)+1,np.ptp(y)+1], [21,21], atol=1)
                    self.assertLess(int(np.ptp(pixels,axis=2).max()), 10)

    def test_custom_ranges_and_overlaps(self):
        clips = [{"id":"a","start":1,"end":4}]
        extra = {"id":"custom-one","start":3,"end":6,"title":"추가"}
        options = {"ids":["a",extra["id"]],"custom":[extra],"ranges":{"a":{"start":2,"end":3.5}}}
        self.assertEqual(selected_spans(clips,options,8),[[2,6]])
        options["ranges"]["a"]["end"]=9
        with self.assertRaises(ValueError):
            selected_spans(clips,options,8)

    def test_global_and_individual_caption_timing(self):
        cues = [{"start":.5,"end":1.5,"text":"원본"},{"start":2,"end":4,"text":"둘"}]
        options = {"captionShift":-.3,"captionEdits":{"0":{"start":.1,"end":1.2,"text":"수정"}}}
        first,second = edited_cues(cues,options,5)
        self.assertEqual(first["text"],"수정")
        self.assertEqual(first["start"],0)
        self.assertAlmostEqual(first["end"],.9)
        self.assertAlmostEqual(second["start"],1.7)

    def test_adding_missing_caption_and_omitting_original(self):
        cue = {"start":1, "end":2, "text":"원본"}
        added = {"start":2.25, "end":3, "text":"직접 입력"}
        settings = {"captionEdits":{"0":{**cue,"skip":True}}, "addedCaptions":[added], "captionShift":.1}
        result = edited_cues([cue],settings,6)
        self.assertEqual([line["text"] for line in result],["직접 입력"])
        self.assertAlmostEqual(result[0]["start"],2.35)
        with self.assertRaises(ValueError):
            edited_cues([],{"addedCaptions":[{**added,"end":9}]},6)

    def test_sound_sidecar_and_burned_captions_share_a_clock(self):
        # Audio starts later than video. Use actual decoded pulses and burned glyphs as independent clocks.
        with tempfile.TemporaryDirectory(prefix="cutroom-clock-test-") as tmp:
            folder=Path(tmp)
            rate=16000
            delay=.65
            spans=[(.12,1.42),(1.8,3.09),(3.5,4.79),(5.15,6.52)]
            starts=[.87,2.11,3.83,5.47]
            samples=np.zeros(rate*7,dtype="<i2")
            cues=[]
            for at in starts:
                count=int(.23*rate);index=round((at-delay)*rate)
                samples[index:index+count]=(16000*np.sin(np.arange(count)*2*np.pi*890/rate)).astype("<i2")
                cues.append({"start":at,"end":at+.23,"text":"TEST"})
            with wave.open(str(folder/"pulses.wav"),"wb") as wav:
                wav.setparams((1,2,rate,0,"NONE","not compressed"))
                wav.writeframes(samples.tobytes())
            source=folder/"source.mkv"
            media.ff(["-f","lavfi","-i","color=c=black:size=192x108:r=30:d=8","-itsoffset",str(delay),
                      "-i",folder/"pulses.wav","-map","0:v","-map","1:a","-c:v","libx264","-c:a","pcm_s16le",source])
            path=media.speech_audio(source,folder)
            with wave.open(str(path)) as wav:
                signal=np.frombuffer(wav.readframes(wav.getnframes()),dtype="<i2")
            self.assertAlmostEqual(np.flatnonzero(np.abs(signal)>600)[0]/rate,starts[0],delta=.002)
            _, peaks = media.audio_envelope(path)
            first_peak = next(i for i, peak in enumerate(peaks) if peak > 30) / media.PEAKS_PER_SECOND
            self.assertAlmostEqual(first_peak, starts[0], delta=1/media.PEAKS_PER_SECOND)
            def heard_times(asset):
                raw = media.ff(["-i",asset,"-vn","-ac","1","-ar","16000","-f","s16le","pipe:1"])
                audio = np.frombuffer(raw, dtype="<i2")
                blocks = audio[:len(audio)//80*80].reshape(-1,80).astype(float)
                heard = np.sqrt(np.mean(blocks**2,axis=1)) > 800
                return np.flatnonzero(heard & ~np.r_[False,heard[:-1]]) / 200
            proxy = folder / "editing-source.mp4"
            media.editing_source(source, proxy, media.probe(source))
            np.testing.assert_allclose(heard_times(proxy), starts, atol=.01, rtol=0)
            clips=[{"id":str(i),"start":a,"end":b} for i,(a,b) in enumerate(spans)]
            options={**DEFAULTS,"transition":False,"ids":[c["id"] for c in clips]}
            out=media.render_output(folder,source,media.probe(source),clips,cues,"main",options,lambda _:None)
            video=folder/out["file"]
            audio_times=heard_times(video)
            pixels=media.ff(["-i",video,"-an","-vf","crop=iw:ih/3:0:2*ih/3,scale=192:32,format=gray","-f","rawvideo","pipe:1"])
            shown=np.frombuffer(pixels,dtype=np.uint8).reshape(-1,192*32).max(axis=1)>55
            frame_times=np.flatnonzero(shown & ~np.r_[False,shown[:-1]])/24
            srt_times=[c["start"] for c in parse_captions(folder/out["srt"],out["duration"])]
            self.assertEqual(len(audio_times),len(starts))
            np.testing.assert_allclose(frame_times,audio_times,atol=1/24+.005,rtol=0)
            np.testing.assert_allclose(srt_times,audio_times,atol=.01,rtol=0)


if __name__=="__main__":
    unittest.main()

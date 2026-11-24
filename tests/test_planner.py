import unittest
from pathlib import Path

from cutroom.planner import make_plan, parse_captions, question_replies, remove_quiet_gaps


class EditingTests(unittest.TestCase):
    def test_distinct_exchanges_survive_repeated_high_scoring_explanation(self):
        review = ["왜 약분하면 값이 같나요?", "핵심은 분자와 분모를 같이 나누는 거예요.", "아하, 그래서 같은 피자 양이군요!",
                  "여섯 조각 중 두 조각을 직접 그려요.", "두 조각을 묶으면 한 조각이 보이네요.", "이제 삼분의 일과 비교해 봐요.",
                  "같은 넓이라는 건 이제 알겠어요.", "오늘 정리한 방법으로 약분해요."]
        topics = [("온도계","액체 팽창","눈금"), ("옥타브","진동수 두 배","음 이름"), ("달의 모양","태양이 비추는 방향","초승달"),
                  ("온실","유리벽에 갇힌 열","식물"), ("사막","수증기와 복사 냉각","일교차"), ("강의 침식","빠른 물살","퇴적"),
                  ("나침반","지구 자기장","자석"), ("지렛대","받침점과 거리","회전"), ("무지개","물방울의 빛 분산","일곱 색"),
                  ("모래성","표면 장력","젖은 모래")]
        cues = []
        for chapter in range(20):
            if chapter % 2:
                topic, cause, observation = topics[chapter // 2]
                lines = [f"왜 {topic}에서는 이런 일이 생기나요?", f"핵심은 {cause} 원리예요.", f"아하! {observation} 현상을 설명할 수 있겠어요."]
                step, length = 17, 15
            else:
                lines = review.copy()
                if chapter % 4 == 2:
                    lines[0] = "선생님, " + lines[0]
                step, length = 7, 6
            for j, line in enumerate(lines):
                at = chapter * 150 + 15 + j * step
                speaker = "학생: " if j % 2 == 0 else "선생님: "
                cues.append({"start": at, "end": at+length, "text": speaker+line})
        selected = [s for s in make_plan(3000, cues, [.5]*3000, "main") if s["included"]]
        chapters = [int((s["start"] + s["end"]) / 2 // 150) for s in selected]
        self.assertGreaterEqual(len({i for i in chapters if i % 2}), 4)
        self.assertLessEqual(sum(i % 2 == 0 for i in chapters), 2)
        self.assertTrue(300 <= sum(s["end"]-s["start"] for s in selected) <= 600)

    def test_short_does_not_leave_a_question_behind_at_its_cutoff(self):
        lines = [(.5,7,"학생: 자꾸 헷갈려요. 왜 분모가 다르면 바로 더할 수 없나요?"),
                 (8,15,"선생님: 핵심은 조각의 크기예요. 서로 다른 크기를 비교해 볼까요?"),
                 (16,24,"학생: 아하, 그래서 같은 크기로 잘라야 하는군요!"),
                 (26,34,"선생님: 정확해요. 피자 그림을 직접 겹쳐 볼게요."),
                 (36,43,"학생: 위에 올려 보니 칸이 어긋나네요."), (45,50,"학생: 그러면 공통분모를 육으로 골라도 될까요?"),
                 (50.5,58,"선생님: 네, 육은 이와 삼의 공배수라서 양쪽을 같은 크기로 나눌 수 있어요."),
                 (65,70,"다음 페이지를 펴세요."), (85,92,"다음 장으로 갈게요."), (119,125,"수고했어요.")]
        cues = [{"start":a,"end":b,"text":line} for a,b,line in lines]
        short = next(s for s in make_plan(130, cues, [.5]*130, "short") if s["included"])
        self.assertTrue(short["end"] <= 45 or (short["start"] <= 45 and short["end"] >= 58))
        self.assertTrue(15 < short["end"] - short["start"] <= 55)
        cues[6]["end"] = 53.8
        short = next(s for s in make_plan(130, cues, [.5]*130, "short") if s["included"])
        self.assertTrue(short["start"] <= 45 and 53.8 <= short["end"] <= short["start"] + 55)

    def test_overlapping_student_interjection_is_not_a_pause_in_the_teacher_explanation(self):
        scene = {"start":0,"end":50,"title":"판서","reason":"설명"}
        cues = [{"start":2,"end":25}, {"start":9,"end":10}, {"start":17,"end":21}]
        self.assertEqual(remove_quiet_gaps([scene], cues, [0]*50), ([scene], []))

    def test_students_follow_up_comment_does_not_replace_teachers_answer(self):
        cues = [{"start":1,"end":4,"text":"학생: 공통분모가 뭔가요?"},
                {"start":4.2,"end":5,"text":"학생: 아직 조금 헷갈려요."},
                {"start":5.1,"end":8,"text":"선생님: 두 분모의 공배수예요."}]
        self.assertEqual(question_replies(cues), {0:2})

    def test_lecture_length_and_no_overlap(self):
        for duration in (3000, 3300, 3600):
            cues = [{"start":n, "end":n+5, "text":"왜 이렇게 될까요? 직접 비교해 볼게요."} for n in range(0,duration-5,8)]
            for mode in ("main","short"):
                clips = make_plan(duration,cues,[],mode)
                selected = [c for c in clips if c["included"]]
                total = sum(c["end"]-c["start"] for c in selected)
                self.assertTrue(300 <= total <= 600 if mode=="main" else 0 < total <= 55)
                self.assertTrue(all(a["end"]<=b["start"]+.002 for a,b in zip(clips,clips[1:])))

    def test_demo_cuts_preserve_spoken_lines(self):
        path = Path(__file__).resolve().parents[1]/"assets/demo/lesson.srt"
        cues = parse_captions(path,89.2)
        for mode in ("main","short"):
            for cut in make_plan(89.2,cues,[],mode):
                if cut["included"]:
                    for at in (cut["start"],cut["end"]):
                        self.assertFalse(any(c["start"]+.02 < at < c["end"]-.02 for c in cues))

    def test_short_silent_inputs(self):
        for duration in (.2,3.5,10,51,130):
            for mode in ("main","short"):
                clips = make_plan(duration,[],[],mode)
                self.assertTrue(any(c["included"] for c in clips))
                self.assertTrue(all(0 <= c["start"] < c["end"] <= duration for c in clips))

    def test_quiet_gap_is_recoverable_and_reaction_keeps_its_pause(self):
        selected = [{"start":0,"end":45,"title":"질문과 답","reason":"대화"}]
        cues = [{"start":2,"end":6},{"start":13,"end":16},{"start":17,"end":24}]
        kept, removed = remove_quiet_gaps(selected,cues,[0]*45)
        self.assertEqual(len(kept),2)
        self.assertEqual([(r["start"],r["end"]) for r in removed],[(6.7,12.3)])
        self.assertEqual(remove_quiet_gaps(selected,cues,[1]*45)[1],[])


if __name__ == "__main__":
    unittest.main()

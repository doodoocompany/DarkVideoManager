"""Fast contract tests; no model downloads or translation requests."""
import os
import errno
import json
import queue
from contextlib import nullcontext
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
import wave
from unittest.mock import Mock, patch

import generate
import atomic_output


class SubtitleTests(unittest.TestCase):
    def worker_args(self, output, translate_ko=False, resume=False):
        audio = output / "audio.wav"
        if not audio.exists():
            with wave.open(str(audio), "wb") as source:
                source.setnchannels(1)
                source.setsampwidth(2)
                source.setframerate(16000)
                source.writeframes(b"\0\0" * 160000)
        return SimpleNamespace(audio=str(audio), output=str(output), model="base",
                               language="auto", translate_ko=translate_ko, resume=resume)

    def test_timestamp_carries_milliseconds_into_next_minute(self):
        self.assertEqual(generate.timestamp(59.9996), "00:01:00,000")
        self.assertEqual(generate.timestamp(3661.123), "01:01:01,123")
        for invalid in (-1, float("inf"), float("nan")):
            with self.assertRaises(ValueError):
                generate.timestamp(invalid)

    def test_no_speech_does_not_create_empty_subtitle(self):
        with self.assertRaisesRegex(ValueError, "음성이 감지되지"):
            generate.make_cues([], 10)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "empty.srt"
            with self.assertRaises(ValueError):
                generate.save_srt([], target)
            self.assertFalse(target.exists())

    def test_short_meaningful_speech_is_preserved_and_bounds_clamped(self):
        segments = [SimpleNamespace(start=-0.1, end=0.2, text="네"),
                    SimpleNamespace(start=1, end=11, text="끝")]
        self.assertEqual(generate.make_cues(segments, 10), [generate.Cue(0, .2, "네"), generate.Cue(1, 10, "끝")])

    def test_rejects_invalid_or_unsorted_timings(self):
        for start, end in [(float("nan"), 1), (0, float("inf")), (2, 1)]:
            with self.assertRaises(ValueError):
                generate.make_cues([SimpleNamespace(start=start, end=end, text="hello")], 10)
        with self.assertRaises(ValueError):
            generate.make_cues([SimpleNamespace(start=5, end=6, text="first"), SimpleNamespace(start=1, end=2, text="second")], 10)

    def test_srt_escapes_markup_and_cue_injection_without_overwriting(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "original.srt"
            generate.save_srt([generate.Cue(0, 1, "<b>hello</b>\n\n2\n00:00:02 --> 00:00:03 &")], target)
            text = target.read_text(encoding="utf-8")
            self.assertEqual(text.count("\n\n"), 1)
            self.assertIn("&lt;b&gt;hello&lt;/b&gt;", text)
            self.assertIn("&amp;", text)
            with self.assertRaises(FileExistsError):
                generate.save_srt([generate.Cue(0, 1, "replacement")], target)

    @patch.object(generate, "emit")
    def test_translation_preserves_timing_order_and_maps_chinese(self, emit):
        options = []
        class Translator:
            def __init__(self, *args, **kwargs):
                options.append(kwargs)
            def translate(self, text):
                return {"hello": "안녕하세요", "bye": "안녕"}[text]
        source = [generate.Cue(1, 2, "hello"), generate.Cue(3, 4, "bye")]
        result = generate.translate_cues(source, "zh", Translator)
        self.assertEqual(options, [{"source": "zh-CN", "target": "ko"}])
        self.assertEqual(result, [generate.Cue(1, 2, "안녕하세요"), generate.Cue(3, 4, "안녕")])
        self.assertEqual(source[0].text, "hello")
        devices = [call.kwargs for call in emit.call_args_list if call.kwargs.get("type") == "processing_device"]
        self.assertTrue(devices)
        self.assertTrue(all(event == {"type": "processing_device", "translation": "cloud"} for event in devices))

    @patch.object(generate, "emit")
    def test_cloud_failure_switches_without_repeating_billed_request(self, emit):
        calls = []
        class Translator:
            def __init__(self, *args, **kwargs):
                pass
            def translate(self, text):
                calls.append(text)
                raise RuntimeError("network unavailable")
        def unavailable():
            raise RuntimeError("Ollama unavailable")
        with self.assertRaisesRegex(RuntimeError, "1/1"):
            generate.translate_cues([generate.Cue(0, 1, "hello")], "en", Translator, sleep=lambda seconds: None, local_factory=unavailable)
        self.assertEqual(len(calls), 1)

    @patch.object(generate, "emit")
    def test_cloud_limit_switches_once_to_local_for_remaining_cues(self, emit):
        cloud_calls, local_calls = [], []
        class TooManyRequests(Exception):
            pass
        class Cloud:
            def __init__(self, *args, **kwargs):
                pass
            def translate(self, text):
                cloud_calls.append(text)
                raise TooManyRequests()
        class Local:
            def translate(self, text):
                local_calls.append(text)
                return "한국어 " + text
        cues = [generate.Cue(1, 2, "first"), generate.Cue(3, 4, "second")]
        result = generate.translate_cues(cues, "en", Cloud, local_factory=Local)
        self.assertEqual(cloud_calls, ["first"])
        self.assertEqual(local_calls, ["first", "second"])
        self.assertEqual(result, [generate.Cue(1, 2, "한국어 first"), generate.Cue(3, 4, "한국어 second")])
        self.assertTrue(any("로컬 Ollama" in call.kwargs.get("message", "") for call in emit.call_args_list))
        devices = [call.kwargs for call in emit.call_args_list if call.kwargs.get("type") == "processing_device"]
        self.assertTrue(devices)
        self.assertTrue(all(event["translation"] == "ollama" for event in devices))

    def test_rejects_empty_nonstring_and_excessive_translation_results(self):
        for result in (None, "", "   ", ["text"], "x" * 501, "<think>reasoning</think>"):
            with self.assertRaises(ValueError):
                generate.validate_translation(result, "hello")

    @patch.object(generate, "emit")
    def test_korean_source_does_not_call_translation_service(self, emit):
        source = [generate.Cue(0, 1, "안녕")]
        result = generate.translate_cues(source, "ko", lambda **kwargs: self.fail("unnecessary translation"))
        self.assertEqual(source, result)
        self.assertIn({"type": "processing_device", "translation": "original-ko"},
                      [call.kwargs for call in emit.call_args_list])

    @patch.object(generate, "emit")
    def test_translation_resume_skips_completed_cues_and_checkpoints_new_cues(self, emit):
        calls, saved = [], []
        class Translator:
            def __init__(self, *args, **kwargs):
                pass
            def translate(self, text):
                calls.append(text)
                return "한국어 " + text
        source = [generate.Cue(1, 2, "first"), generate.Cue(3, 4, "second")]
        completed = [generate.Cue(1, 2, "첫째")]
        result = generate.translate_cues(source, "en", Translator, completed=completed, on_cue=saved.append)
        self.assertEqual(calls, ["second"])
        self.assertEqual(saved, [generate.Cue(3, 4, "한국어 second")])
        self.assertEqual(result, completed + saved)
        self.assertEqual(emit.call_args_list[0].kwargs["percent"], 50)

    @patch.object(generate, "emit")
    def test_translation_resume_when_complete_never_creates_provider(self, emit):
        source = [generate.Cue(1, 2, "first")]
        completed = [generate.Cue(1, 2, "첫째")]
        result = generate.translate_cues(source, "en", lambda **kwargs: self.fail("unnecessary provider"),
                                          completed=completed, on_cue=lambda cue: self.fail("already saved"))
        self.assertEqual(result, completed)

    @patch.object(generate, "emit")
    def test_without_cloud_bridge_only_local_provider_is_used(self, emit):
        local = Mock()
        local.translate.return_value = "안녕"
        with patch.object(generate, "translation_deadline", return_value=nullcontext()), \
             patch.dict(sys.modules, {"deep_translator": None}):
            result = generate.translate_cues([generate.Cue(0, 1, "hello")], "en", local_factory=lambda: local)
        self.assertEqual(result, [generate.Cue(0, 1, "안녕")])
        local.translate.assert_called_once_with("hello")
        self.assertFalse(any(call.kwargs.get("type") == "cloud_translation_request" for call in emit.call_args_list))

    @patch.object(generate, "emit")
    def test_cloud_limit_after_success_preserves_prefix_and_switches_remaining_cues(self, emit):
        bridge, local, saved, requests = generate.CloudTranslationBridge(timeout=.1), Mock(), [], []
        def respond(**event):
            if event.get("type") != "cloud_translation_request":
                return
            requests.append(event)
            response = {"type": "cloud_translation_response", "id": event["id"]}
            if event["id"] == 1:
                response.update(ok=True, text="둘째")
            else:
                response.update(ok=False, reason="이번 달 사용 한도에 도달했습니다.")
            bridge.receive(json.dumps(response).encode())
        emit.side_effect = respond
        local.translate.side_effect = ["셋째", "넷째"]
        source = [generate.Cue(index, index + .5, str(index + 1)) for index in range(4)]
        completed = [generate.Cue(0, .5, "첫째")]
        with patch.object(generate, "translation_deadline", return_value=nullcontext()):
            result = generate.translate_cues(source, "en", lambda **kwargs: generate.CloudTranslator(bridge, "en"),
                                            local_factory=lambda: local, completed=completed, on_cue=saved.append)
        self.assertEqual([request["text"] for request in requests], ["2", "3"])
        self.assertTrue(bridge.disabled)
        self.assertEqual([call.args[0] for call in local.translate.call_args_list], ["3", "4"])
        self.assertEqual(result, completed + saved)
        self.assertEqual([cue.text for cue in result], ["첫째", "둘째", "셋째", "넷째"])
        self.assertEqual([(cue.start, cue.end) for cue in result], [(cue.start, cue.end) for cue in source])

    def test_bridge_matches_ids_ignores_unsolicited_replies_and_unescapes_once(self):
        bridge = generate.CloudTranslationBridge(timeout=.1)
        requests = []
        def respond(**event):
            requests.append(event)
            bridge.receive(json.dumps({"type": "cloud_translation_response", "id": event["id"] + 1,
                                       "ok": True, "text": "wrong"}).encode())
            bridge.receive(json.dumps({"type": "cloud_translation_response", "id": event["id"],
                                       "ok": True, "text": "안녕 &amp; &amp;lt;"}).encode())
        with patch.object(generate, "emit", side_effect=respond):
            self.assertEqual(bridge.translate("hello", "en"), "안녕 & &lt;")
            self.assertEqual(bridge.translate("こんにちは", "ja"), "안녕 & &lt;")
        self.assertEqual(requests, [
            {"type": "cloud_translation_request", "id": 1, "text": "hello", "language": "en"},
            {"type": "cloud_translation_request", "id": 2, "text": "こんにちは", "language": "ja"},
        ])

    def test_bridge_timeout_disables_cloud_without_reissuing_request(self):
        bridge = generate.CloudTranslationBridge(timeout=.01)
        with patch.object(generate, "emit") as emit:
            with self.assertRaisesRegex(generate.CloudTranslationError, "초과"):
                bridge.translate("hello", "en")
            bridge.receive(b'{"type":"cloud_translation_response","id":1,"ok":true,"text":"late"}')
            with self.assertRaisesRegex(generate.CloudTranslationError, "중단"):
                bridge.translate("again", "en")
        self.assertEqual(emit.call_count, 1)

    def test_bridge_malformed_response_is_safe_and_never_echoes_raw_content(self):
        for raw in (b"PRIVATE KEY is not JSON", b"[]", b"\xff", b"x" * (1024 * 1024 + 1),
                    b'{"type":"cloud_translation_response","id":1,"ok":true,"text":42}'):
            with self.subTest(length=len(raw)):
                bridge = generate.CloudTranslationBridge(timeout=.1)
                with patch.object(generate, "emit", side_effect=lambda **kwargs: bridge.receive(raw)):
                    with self.assertRaisesRegex(generate.CloudTranslationError, "형식") as error:
                        bridge.translate("hello", "en")
                self.assertNotIn("PRIVATE", str(error.exception))

    def test_dependencies_do_not_require_unofficial_google_translator(self):
        whisper_model = object()
        with patch.dict(sys.modules, {"faster_whisper": SimpleNamespace(WhisperModel=whisper_model),
                                      "deep_translator": None, "requests": SimpleNamespace()}):
            self.assertIs(generate.load_dependencies(True), whisper_model)

    def child_events(self, child):
        events = queue.Queue()
        def read():
            for line in child.stdout:
                events.put(json.loads(line))
        threading.Thread(target=read, daemon=True).start()
        return events

    def stop_child(self, child):
        if child.poll() is None:
            child.kill()
            child.wait(timeout=3)
        if not child.stdin.closed:
            child.stdin.close()
        child.stdout.close()
        child.stderr.close()

    def test_main_bridge_resumes_checkpoint_and_reads_fragmented_multiple_responses(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            args = self.worker_args(output, translate_ko=True, resume=True)
            identity = generate.checkpoint_identity(Path(args.audio), args, 10)
            state = generate.load_checkpoint(output, identity, True)
            state.update(language="ja", transcription_complete=True, transcribed_until=10,
                         cues=[generate.asdict(generate.Cue(i, i + .5, text)) for i, text in enumerate(("first", "second", "third"))],
                         translated=[generate.asdict(generate.Cue(0, .5, "첫째"))])
            generate.save_checkpoint(output, state)
            child = subprocess.Popen(
                [sys.executable, "-X", "utf8", "-B", str(Path(generate.__file__)), "--audio", args.audio,
                 "--output", args.output, "--translate-ko", "--resume", "--cloud-translation-bridge"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            events = self.child_events(child)
            requests = []
            try:
                while True:
                    event = events.get(timeout=5)
                    if event.get("type") == "cloud_translation_request":
                        requests.append(event)
                        text = "둘째 &amp;" if event["id"] == 1 else "셋째"
                        response = json.dumps({"type": "cloud_translation_response", "id": event["id"], "ok": True, "text": text}).encode() + b"\n"
                        child.stdin.write(response[:17])
                        child.stdin.flush()
                        child.stdin.write(response[17:])
                        child.stdin.flush()
                    if event.get("phase") == "completed":
                        self.assertEqual(event.get("translated"), "ko.srt")
                        break
                self.assertEqual(child.wait(timeout=3), 0)
            finally:
                self.stop_child(child)
            self.assertEqual([(item["id"], item["text"], item["language"]) for item in requests], [(1, "second", "ja"), (2, "third", "ja")])
            result = json.loads((output / "checkpoint.json").read_text(encoding="utf-8"))
            self.assertEqual(result["translated"][0], state["translated"][0])
            self.assertEqual([cue["text"] for cue in result["translated"]], ["첫째", "둘째 &", "셋째"])
            self.assertEqual(result["cues"], state["cues"])
            self.assertIn("둘째 &amp;", (output / "ko.srt").read_text(encoding="utf-8"))

    def test_stdin_bridge_bounds_invalid_lines_and_eof_interrupts_pending_request(self):
        for payload, expected_exit in ((b"PRIVATE RAW DATA\n", 1), (b"x" * 8192 + b"\n", 1), (None, 130)):
            with self.subTest(payload_size=None if payload is None else len(payload)):
                script = (
                    "import generate; generate.CloudTranslationBridge.MAX_LINE_BYTES=128; "
                    "generate.run=lambda args: args.cloud_translation_client.translate('hello','en'); "
                    "raise SystemExit(generate.main())"
                )
                child = subprocess.Popen([sys.executable, "-X", "utf8", "-B", "-c", script, "--cloud-translation-bridge"],
                                         cwd=Path(__file__).parent, stdin=subprocess.PIPE,
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                events = self.child_events(child)
                try:
                    self.assertEqual(events.get(timeout=5)["type"], "cloud_translation_request")
                    if payload is None:
                        child.stdin.close()
                    else:
                        child.stdin.write(payload)
                        child.stdin.flush()
                    self.assertEqual(child.wait(timeout=3), expected_exit)
                    self.assertNotIn(b"PRIVATE RAW DATA", child.stderr.read())
                finally:
                    self.stop_child(child)

    @patch.object(generate, "emit")
    def test_worker_resume_offsets_remaining_audio_and_preserves_language(self, emit):
        class Paused(BaseException):
            pass
        class FirstModel:
            def __init__(self, *args, **kwargs):
                pass
            def transcribe(self, *args, **kwargs):
                def segments():
                    yield SimpleNamespace(start=1, end=2, text="first")
                    raise Paused()
                return segments(), SimpleNamespace(language="en")
        calls = []
        remaining_audio = object()
        class ResumedModel:
            def __init__(self, *args, **kwargs):
                pass
            def transcribe(self, source, **kwargs):
                calls.append((source, kwargs))
                return iter([SimpleNamespace(start=1, end=2.5, text="second")]), SimpleNamespace(language="en")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            args = self.worker_args(output)
            with patch.object(generate, "load_dependencies", return_value=FirstModel), self.assertRaises(Paused):
                generate.run(args)
            checkpoint = json.loads((output / "checkpoint.json").read_text())
            self.assertEqual(checkpoint["transcribed_until"], 2)
            self.assertFalse(checkpoint["transcription_complete"])
            self.assertEqual(checkpoint["cues"], [{"start": 1, "end": 2, "text": "first"}])
            args.resume = True
            with patch.object(generate, "load_dependencies", return_value=ResumedModel), \
                 patch.object(generate, "decode_resume_audio", return_value=remaining_audio) as decode:
                generate.run(args)
            decode.assert_called_once_with(Path(args.audio), 2)
            self.assertIs(calls[0][0], remaining_audio)
            self.assertEqual(calls[0][1]["language"], "en")
            text = (output / "original.srt").read_text()
            self.assertEqual(text.count("first"), 1)
            self.assertIn("00:00:03,000 --> 00:00:04,500\nsecond", text)
            self.assertEqual(emit.call_args.kwargs["cueCount"], 2)
            devices = [call.kwargs for call in emit.call_args_list if call.kwargs.get("type") == "processing_device"]
            self.assertEqual(devices, [{"type": "processing_device", "asr_backend": "cpu-legacy"}] * 2)

    @patch.object(generate, "emit")
    def test_worker_resume_translation_skips_transcription_and_restores_staging(self, emit):
        class Paused(BaseException):
            pass
        class Model:
            def __init__(self, *args, **kwargs):
                pass
            def transcribe(self, *args, **kwargs):
                return iter([SimpleNamespace(start=0, end=1, text="first"),
                             SimpleNamespace(start=2, end=3, text="second")]), SimpleNamespace(language="en")
        def initial_translation(cues, language, completed, on_cue, translator_factory):
            self.assertEqual(completed, [])
            on_cue(generate.Cue(0, 1, "첫째"))
            raise Paused()
        def resumed_translation(cues, language, completed, on_cue, translator_factory):
            self.assertEqual(completed, [generate.Cue(0, 1, "첫째")])
            translated = generate.Cue(2, 3, "둘째")
            on_cue(translated)
            return completed + [translated]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            args = self.worker_args(output, translate_ko=True)
            with patch.object(generate, "load_dependencies", return_value=Model), \
                 patch.object(generate, "translate_cues", side_effect=initial_translation), self.assertRaises(Paused):
                generate.run(args)
            checkpoint = json.loads((output / "checkpoint.json").read_text())
            self.assertTrue(checkpoint["transcription_complete"])
            self.assertEqual(len(checkpoint["translated"]), 1)
            # A stopped publication must also be safely regenerated on resume.
            (output / "original.srt").write_text("unfinished staging output")
            args.resume = True
            with patch.object(generate, "load_dependencies", side_effect=AssertionError("Whisper must not load")), \
                 patch.object(generate, "translate_cues", side_effect=resumed_translation):
                generate.run(args)
            self.assertIn("first", (output / "original.srt").read_text())
            self.assertIn("둘째", (output / "ko.srt").read_text())
            self.assertEqual(emit.call_args.kwargs["translated"], "ko.srt")
            self.assertEqual(len(json.loads((output / "checkpoint.json").read_text())["translated"]), 2)

    def test_corrupt_checkpoint_fails_without_overwriting_saved_progress(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            args = self.worker_args(output, resume=True)
            checkpoint = output / "checkpoint.json"
            checkpoint.write_text('{"version": 1, "cues": [')
            before = checkpoint.read_bytes()
            with patch.object(generate, "load_dependencies") as dependencies, \
                 self.assertRaisesRegex(ValueError, "재개 정보를 읽을 수 없습니다"):
                generate.run(args)
            dependencies.assert_not_called()
            self.assertEqual(checkpoint.read_bytes(), before)
            self.assertFalse((output / "original.srt").exists())

    def test_changed_options_or_audio_cannot_reuse_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            args = self.worker_args(output, resume=True)
            identity = generate.checkpoint_identity(Path(args.audio), args, 10)
            state = generate.load_checkpoint(output, identity, True)
            generate.save_checkpoint(output, state)
            args.model = "small"
            with self.assertRaisesRegex(ValueError, "옵션이 저장된 작업과 다릅니다"):
                generate.run(args)
            args.model = "base"
            with Path(args.audio).open("r+b") as audio:
                audio.seek(-2, os.SEEK_END)
                audio.write(b"\1\0")
            with self.assertRaisesRegex(ValueError, "옵션이 저장된 작업과 다릅니다"):
                generate.run(args)

    def test_atomic_checkpoint_failure_keeps_previous_valid_file(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            generate.save_checkpoint(output, {"valid": 1})
            with patch.object(generate.os, "replace", side_effect=OSError("interrupted")), self.assertRaises(OSError):
                generate.save_checkpoint(output, {"valid": 2})
            self.assertEqual(json.loads((output / "checkpoint.json").read_text()), {"valid": 1})
            self.assertEqual(sorted(path.name for path in output.iterdir()), ["checkpoint.json"])

    def test_wsl_fallback_updates_checkpoint_and_staged_subtitle(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            generate.save_checkpoint(output, {"translated": []})
            generate.save_srt([generate.Cue(0, 1, "first")], output / "original.srt")
            native_replace = os.replace
            error = IsADirectoryError(errno.EISDIR, "Is a directory")
            with patch.object(atomic_output.os, "replace", side_effect=error), \
                 patch.object(atomic_output, "_is_wsl", return_value=True), \
                 patch.object(atomic_output, "_replace_in_windows", side_effect=native_replace) as fallback:
                generate.save_checkpoint(output, {"translated": ["번역 완료"]})
                generate.save_srt([generate.Cue(0, 1, "continued")], output / "original.srt", replace_staged=True)
            self.assertEqual(fallback.call_count, 2)
            self.assertEqual(json.loads((output / "checkpoint.json").read_text(encoding="utf-8")),
                             {"translated": ["번역 완료"]})
            self.assertIn("continued", (output / "original.srt").read_text(encoding="utf-8"))
            self.assertEqual(sorted(path.name for path in output.iterdir()), ["checkpoint.json", "original.srt"])

    def test_wsl_fallback_failure_preserves_checkpoint_and_cleans_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            generate.save_checkpoint(output, {"valid": 1})
            before = (output / "checkpoint.json").read_bytes()
            with patch.object(atomic_output.os, "replace", side_effect=IsADirectoryError(errno.EISDIR, "Is a directory")), \
                 patch.object(atomic_output, "_is_wsl", return_value=True), \
                 patch.object(atomic_output, "_replace_in_windows", side_effect=OSError("native failure")), \
                 self.assertRaisesRegex(OSError, "Windows에서 저장하지 못했습니다"):
                generate.save_checkpoint(output, {"valid": 2})
            self.assertEqual((output / "checkpoint.json").read_bytes(), before)
            self.assertEqual(sorted(path.name for path in output.iterdir()), ["checkpoint.json"])

    def test_resume_decoder_slices_at_saved_sample_boundary(self):
        calls = []
        samples = list(range(160))
        def decode(audio, sampling_rate):
            calls.append((audio, sampling_rate))
            return samples
        with patch.dict(sys.modules, {"faster_whisper.audio": SimpleNamespace(decode_audio=decode)}):
            self.assertEqual(generate.decode_resume_audio(Path("audio.wav"), 0.005), samples[80:])
        self.assertEqual(calls, [("audio.wav", 16000)])

    def test_resume_without_checkpoint_does_not_overwrite_existing_subtitles(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            args = self.worker_args(output, resume=True)
            original = output / "original.srt"
            original.write_text("existing subtitle")
            with self.assertRaisesRegex(ValueError, "재개 정보가 없습니다"):
                generate.run(args)
            self.assertEqual(original.read_text(), "existing subtitle")

    @unittest.skipIf(os.name == "nt", "The worker runs in WSL")
    def test_closing_stdin_interrupts_busy_worker(self):
        script = (
            "import generate,time; "
            "generate.run=lambda args: (generate.emit(phase='loading',percent=0), time.sleep(30)); "
            "raise SystemExit(generate.main())"
        )
        with subprocess.Popen(
            [sys.executable, "-B", "-c", script], cwd=Path(__file__).parent,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        ) as child:
            try:
                self.assertIn(b'"phase": "loading"', child.stdout.readline())
                child.stdin.close()
                self.assertEqual(child.wait(timeout=3), 130)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=3)

    @unittest.skipIf(os.name == "nt", "The worker runs in WSL")
    def test_translation_deadline_interrupts_blocking_call(self):
        with self.assertRaises(TimeoutError):
            with generate.translation_deadline(0.02):
                time.sleep(1)

    @patch.object(generate, "emit")
    def test_worker_preserves_original_and_reports_translation_failure(self, emit):
        class Model:
            def __init__(self, *args, **kwargs):
                pass
            def transcribe(self, *args, **kwargs):
                return iter([SimpleNamespace(start=0, end=1, text="hello")]), SimpleNamespace(language="en")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            args = self.worker_args(output, translate_ko=True)
            with patch.object(generate, "audio_duration", return_value=2), \
                 patch.object(generate, "load_dependencies", return_value=Model), \
                 patch.object(generate, "translate_cues", side_effect=RuntimeError("번역 실패")):
                generate.run(args)
            self.assertTrue((output / "original.srt").exists())
            self.assertFalse((output / "ko.srt").exists())
            self.assertEqual(emit.call_args.kwargs, {
                "phase": "completed", "language": "en", "original": "original.srt",
                "cueCount": 1, "translationError": "번역 실패",
            })

    def ollama_response(self, result):
        response = Mock()
        response.json.return_value = result
        response.iter_content.return_value = [(json.dumps(result, ensure_ascii=False) + "\n").encode("utf-8")]
        response.raise_for_status.return_value = None
        return response

    def mock_ollama(self, responses):
        self.enterContext(patch("requests.get", return_value=self.ollama_response({
            "models": [{"name": "qwen3:8b"}],
        })))
        return self.enterContext(patch("requests.post", side_effect=responses))

    def test_retry_compaction_only_shortens_long_identical_unicode_letters(self):
        source = "お" + "ぉ" * 166 + " " + "아" * 10 + " " + "a" * 9 + " " + "é" * 10
        self.assertEqual(generate.compact_translation_repetitions(source), "おぉぉぉ 아아아 aaaaaaaaa ééé")
        preserved = "1" * 50 + "０" * 10 + " " * 20 + "!" * 30 + "-" * 20 + "🙂" * 10
        self.assertEqual(generate.compact_translation_repetitions(preserved), preserved)
        self.assertEqual(source, "お" + "ぉ" * 166 + " " + "아" * 10 + " " + "a" * 9 + " " + "é" * 10)

    def test_retry_compaction_shortens_syllables_and_phrases_with_whitespace_or_punctuation(self):
        for unit in ("いや", "아니", "やめて", "いや、", "아니! ", "Please stop. ", "あ \nい！"):
            with self.subTest(unit=unit):
                original = unit * 17
                self.assertEqual(generate.compact_translation_repetitions(original), unit * 3)
                self.assertEqual(original, unit * 17)
        self.assertEqual(generate.compact_translation_repetitions("いや" * 167), "いや" * 3)

    def test_retry_compaction_preserves_normal_prefix_suffix_and_incomplete_unit(self):
        original = "前の文章。[" + "いや" * 10 + "い] 後の文章。123"
        self.assertEqual(generate.compact_translation_repetitions(original), "前の文章。[" + "いや" * 3 + "い] 後の文章。123")
        self.assertEqual(generate.compact_translation_repetitions("123 " + "いや" * 10 + " 456"), "123 " + "いや" * 3 + " 456")
        normal = "同じ言葉を繰り返す。同じ言葉を繰り返す。短い反復はそのまま。"
        self.assertEqual(generate.compact_translation_repetitions(normal), normal)

    def test_retry_compaction_obeys_repeat_count_and_unit_length_boundaries(self):
        for repeats in (1, 8, 9):
            self.assertEqual(generate.compact_translation_repetitions("いや" * repeats), "いや" * repeats)
        for repeats in (10, 11):
            self.assertEqual(generate.compact_translation_repetitions("いや" * repeats), "いや" * 3)
        unit = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN"
        self.assertEqual(len(unit), 40)
        self.assertEqual(generate.compact_translation_repetitions(unit * 10), unit * 3)
        too_long = unit + "O"
        self.assertEqual(generate.compact_translation_repetitions(too_long * 10), too_long * 10)

    def test_retry_compaction_preserves_numeric_or_letterless_repeated_units(self):
        for unit in ("第1回", "A０", "Ⅻ回", "½杯", "第一回", "A²", "1 ", "! ", "\t \n", "🙂!", "「」", "_"):
            with self.subTest(unit=unit):
                original = unit * 12
                self.assertEqual(generate.compact_translation_repetitions(original), original)

    def test_numeric_enumeration_preserves_exact_counting_sequence_without_model_output(self):
        numbers = "1、2、3、2、3、2、" + "1、2、" * 50 + "1"
        source = "はい、" + numbers
        post = self.mock_ollama([self.ollama_response({"done": True, "response": "네"})])
        translator = generate.OllamaTranslator("ja", sleep=lambda seconds: None)
        self.assertEqual(translator.translate(source), "네、" + numbers)
        self.assertEqual(post.call_count, 1)
        self.assertIn("\nはい\n", post.call_args.kwargs["json"]["prompt"])
        self.assertNotIn(numbers, post.call_args.kwargs["json"]["prompt"])
        self.assertEqual(source, "はい、" + numbers)

    def test_numeric_enumeration_numeric_only_and_punctuation_need_no_model_request(self):
        numbers = "01, 02, 003, 4, 5, 6, 7, 008"
        post = self.mock_ollama([])
        translator = generate.OllamaTranslator("ja", sleep=lambda seconds: None)
        self.assertEqual(translator.translate(numbers), numbers)
        self.assertEqual(translator.translate("「" + numbers + "」！"), "「" + numbers + "」！")
        self.assertEqual(translator.translate_enumeration_fragment("、 。！"), "、 。！")
        post.assert_not_called()

    def test_numeric_enumeration_keeps_fullwidth_digits_and_all_source_separators(self):
        numbers = "０１、 ２、３、 ４、５、６、 ７、８"
        source = "開始！ " + numbers + "、終了。"
        spans = generate.numeric_enumeration_spans(source)
        self.assertEqual([source[start:end] for start, end in spans], [numbers])
        post = self.mock_ollama([
            self.ollama_response({"done": True, "response": "시작"}),
            self.ollama_response({"done": True, "response": "끝"}),
        ])
        translator = generate.OllamaTranslator("ja", sleep=lambda seconds: None)
        self.assertEqual(translator.translate(source), "시작！ " + numbers + "、끝。")
        self.assertEqual(post.call_count, 2)
        raw = "1,\t2,  3,4,5,6,7,8"
        self.assertEqual(generate.numeric_enumeration_spans(raw), [(0, len(raw))])

    def test_numeric_enumeration_multiple_lists_keep_source_order(self):
        first, second = "1、2、3、4、5、6、7、8", "9,8,7,6,5,4,3,2,1"
        source = "はい、" + first + "。次は、" + second + "、終わり。"
        post = self.mock_ollama([
            self.ollama_response({"done": True, "response": "네"}),
            self.ollama_response({"done": True, "response": "다음은"}),
            self.ollama_response({"done": True, "response": "끝"}),
        ])
        translator = generate.OllamaTranslator("ja", sleep=lambda seconds: None)
        self.assertEqual(translator.translate(source), "네、" + first + "。다음은、" + second + "、끝。")
        prompts = [call.kwargs["json"]["prompt"] for call in post.call_args_list]
        self.assertEqual(len(prompts), 3)
        for word, prompt in zip(("はい", "次は", "終わり"), prompts):
            self.assertIn("\n" + word + "\n", prompt)

    def test_numeric_enumeration_rejects_short_or_ambiguous_numeric_sequences(self):
        numbers = "1,2,3,4,5,6,7,8,9"
        unchanged = [
            "1,2,3,4,5,6,7", "普通の文です。数字は123です。",
            "第" + numbers, numbers + "章", "v" + numbers, numbers + "%",
            "−" + numbers, "+" + numbers, "－" + numbers, "1.5," + numbers,
            "1.5, " + numbers, numbers + ",9.5", numbers + ",−9", numbers + ", +.5",
            "1kg," + numbers, numbers + ",10kg", "1e3," + numbers,
            numbers + "e3", numbers + "-10", numbers + "°C", "2026/10/01," + numbers, "1.2.3," + numbers,
            ",".join(str(index) + ".5" for index in range(10)),
            ",".join("-" + str(index) for index in range(10)),
        ]
        post = self.mock_ollama([])
        translator = generate.OllamaTranslator("ja", sleep=lambda seconds: None)
        for source in unchanged:
            with self.subTest(source=source), patch.object(translator, "translate_text", return_value="번역") as translate:
                self.assertEqual(generate.numeric_enumeration_spans(source), [])
                self.assertEqual(translator.translate(source), "번역")
                translate.assert_called_once_with(source)
        post.assert_not_called()

    @patch.object(generate, "emit")
    def test_numeric_enumeration_fragment_failure_preserves_checkpoint_until_complete_resume(self, emit):
        numbers = "1、2、3、2、3、2、" + "1、2、" * 50 + "1"
        source_text = "はい、" + numbers + "、続けます。"
        post = self.mock_ollama([
            self.ollama_response({"done": True, "response": "네"}),
            *[self.ollama_response({"done": True, "done_reason": "length", "response": "부분"}) for _ in range(3)],
        ])
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            args = self.worker_args(output, translate_ko=True, resume=True)
            identity = generate.checkpoint_identity(Path(args.audio), args, 10)
            state = generate.load_checkpoint(output, identity, True)
            prefix = [{"start": 0, "end": 1, "text": "첫째"}]
            source = [{"start": 0, "end": 1, "text": "first"}, {"start": 2, "end": 9, "text": source_text}]
            state.update(language="ja", transcription_complete=True, transcribed_until=10,
                         cues=source, translated=prefix)
            generate.save_checkpoint(output, state)
            factory = generate.OllamaTranslator
            with patch.object(generate, "load_dependencies", side_effect=AssertionError("Whisper must not load")), \
                 patch.object(generate, "OllamaTranslator", side_effect=lambda language, **kwargs: factory(language, sleep=lambda seconds: None)):
                generate.run(args)
                failed = json.loads((output / "checkpoint.json").read_text())
                self.assertEqual(failed["translated"], prefix)
                self.assertEqual(failed["cues"], source)
                self.assertFalse((output / "ko.srt").exists())
                self.assertIn("출력 한도", emit.call_args.kwargs["translationError"])
                original = (output / "original.srt").read_bytes()
                post.side_effect = [
                    self.ollama_response({"done": True, "response": "네"}),
                    self.ollama_response({"done": True, "response": "계속합니다"}),
                ]
                with patch.object(generate, "save_checkpoint", wraps=generate.save_checkpoint) as checkpoint:
                    generate.run(args)
                    # run() writes its initialized state once, then exactly one
                    # complete-cue checkpoint; no fragment is persisted alone.
                    self.assertEqual(checkpoint.call_count, 2)
                resumed = json.loads((output / "checkpoint.json").read_text())
            expected = "네、" + numbers + "、계속합니다。"
            self.assertEqual(resumed["translated"], prefix + [{"start": 2, "end": 9, "text": expected}])
            self.assertEqual(resumed["cues"], source)
            self.assertEqual((output / "original.srt").read_bytes(), original)
            original_times = [line for line in original.decode("utf-8").splitlines() if " --> " in line]
            korean_times = [line for line in (output / "ko.srt").read_text().splitlines() if " --> " in line]
            self.assertEqual(korean_times, original_times)
            self.assertEqual(post.call_count, 6)
            for call in post.call_args_list:
                self.assertNotIn(numbers, call.kwargs["json"]["prompt"])

    def test_ollama_success_does_not_change_first_prompt_or_retry(self):
        source = "お" + "ぉ" * 166
        response = self.ollama_response({"done": True, "done_reason": "stop", "response": "  오오!  "})
        post = self.mock_ollama([response])
        sleep = Mock()
        translator = generate.OllamaTranslator("ja", sleep=sleep)
        self.assertEqual(translator.translate(source), "오오!")
        request = post.call_args.kwargs["json"]
        self.assertIn(source, request["prompt"])
        self.assertEqual(request["options"], {"temperature": 0.0, "num_predict": 512})
        self.assertIs(request["think"], False)
        self.assertIs(request["stream"], True)
        self.assertIs(post.call_args.kwargs["stream"], True)
        self.assertEqual(post.call_args.kwargs["timeout"], (5, 120))
        self.assertNotIn("format", request)
        self.assertEqual(post.call_count, 1)
        sleep.assert_not_called()
        response.close.assert_called_once()

    def test_ollama_retries_incomplete_response_with_compacted_prompt(self):
        source = "お" + "ぉ" * 166
        responses = [self.ollama_response({"done": False, "response": "미완성"}),
                     self.ollama_response({"done": True, "done_reason": "stop", "response": "오오!"})]
        post = self.mock_ollama(responses)
        sleep, progress = Mock(), Mock()
        translator = generate.OllamaTranslator("ja", sleep=sleep, on_retry=progress)
        self.assertEqual(translator.translate(source), "오오!")
        first, second = [call.kwargs["json"] for call in post.call_args_list]
        self.assertIn(source, first["prompt"])
        self.assertIn("\nおぉぉぉ\n", second["prompt"])
        self.assertNotIn(source, second["prompt"])
        self.assertEqual(second["options"], {"temperature": 0.0, "num_predict": 512, "repeat_penalty": 1.1})
        self.assertIn("interjections concisely", second["system"])
        self.assertNotIn("format", first)
        self.assertNotIn("format", second)
        self.assertEqual(progress.call_args.args[0], 2)
        self.assertIn("완료되지 않은", progress.call_args.args[1])
        sleep.assert_called_once_with(.5)
        for response in responses:
            response.close.assert_called_once()

    def test_ollama_incomplete_retry_is_bounded_and_never_accepts_partial_text(self):
        post = self.mock_ollama([self.ollama_response({"done": False, "response": "부분 번역"}) for _ in range(3)])
        sleep = Mock()
        translator = generate.OllamaTranslator("ja", sleep=sleep)
        with self.assertRaisesRegex(generate.LocalTranslationError, "완료되지 않은.*3회"):
            translator.translate("hello")
        self.assertEqual(post.call_count, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [.5, 1.0])
        self.assertEqual([call.kwargs["json"]["options"]["num_predict"] for call in post.call_args_list], [512] * 3)

    def test_ollama_only_increases_output_limit_after_length_failure(self):
        post = self.mock_ollama([
            self.ollama_response({"done": True, "done_reason": "length", "response": "잘린 번역"}),
            self.ollama_response({"done": True, "done_reason": "length", "response": "더 긴 잘린 번역"}),
            self.ollama_response({"done": True, "done_reason": "stop", "response": '{"translation": "완성"}'}),
        ])
        translator = generate.OllamaTranslator("ja", sleep=lambda seconds: None)
        self.assertEqual(translator.translate("hello"), "완성")
        self.assertEqual([call.kwargs["json"]["options"]["num_predict"] for call in post.call_args_list], [512, 1024, 2048])

    def test_ollama_each_retry_gets_its_own_deadline_after_timeout(self):
        import requests
        post = self.mock_ollama([
            requests.exceptions.ReadTimeout("private response"),
            TimeoutError("private subtitle"),
            self.ollama_response({"done": True, "response": '{"translation": "성공"}'}),
        ])
        translator = generate.OllamaTranslator("ja", sleep=lambda seconds: None)
        with patch.object(generate, "translation_deadline", side_effect=lambda seconds: nullcontext()) as deadline:
            self.assertEqual(translator.translate("hello"), "성공")
        self.assertEqual([call.args for call in deadline.call_args_list], [(300,), (300,), (300,)])
        self.assertEqual(post.call_count, 3)

    def test_ollama_safe_failure_diagnostics_never_include_raw_response(self):
        import requests
        secret = "PRIVATE SUBTITLE OR RESPONSE"
        invalid_json = self.ollama_response(None)
        invalid_json.iter_content.return_value = [secret.encode("utf-8")]
        errors = [
            (requests.exceptions.ReadTimeout(secret), "응답 시간이 초과"),
            (requests.exceptions.ConnectionError(secret), "연결할 수 없"),
            (requests.exceptions.HTTPError(secret, response=SimpleNamespace(status_code=503)), "상태 503"),
            (invalid_json, "JSON 응답"),
            (self.ollama_response([secret]), "JSON 응답"),
            (self.ollama_response({"error": secret}), "요청을 처리하지 못"),
            (self.ollama_response({"done": "true", "response": secret}), "완료되지 않은"),
            (self.ollama_response({"done": True, "done_reason": "length", "response": secret}), "출력 한도"),
        ]
        for failure, message in errors:
            with self.subTest(message=message):
                post = self.mock_ollama([failure] * 3)
                translator = generate.OllamaTranslator("ja", sleep=lambda seconds: None)
                with self.assertRaises(generate.LocalTranslationError) as caught:
                    translator.translate("hello")
                self.assertIn(message, str(caught.exception))
                self.assertNotIn(secret, str(caught.exception))
                self.assertEqual(post.call_count, 3)

    def test_ollama_third_attempt_uses_structured_output_after_incomplete_responses(self):
        source = "普通の文です。"
        post = self.mock_ollama([
            self.ollama_response({"done": False, "response": "부분 번역"}),
            self.ollama_response({"done": False, "response": "다시 부분 번역"}),
            self.ollama_response({"done": True, "done_reason": "stop", "response": '{"translation": "  평범한 문장입니다.  "}'}),
        ])
        translator = generate.OllamaTranslator("ja", sleep=lambda seconds: None)
        self.assertEqual(translator.translate(source), "평범한 문장입니다.")
        first, second, third = [call.kwargs["json"] for call in post.call_args_list]
        self.assertNotIn("format", first)
        self.assertNotIn("format", second)
        self.assertEqual(third["format"], {
            "type": "object", "properties": {"translation": {"type": "string"}},
            "required": ["translation"], "additionalProperties": False,
        })
        self.assertIn("Return only a JSON object", third["system"])
        self.assertIn(source, third["prompt"])
        self.assertEqual([request["options"]["num_predict"] for request in (first, second, third)], [512] * 3)
        self.assertEqual(post.call_count, 3)

    def test_ollama_structured_final_response_is_strict_and_diagnostics_are_safe(self):
        secret = "PRIVATE SUBTITLE OR RESPONSE"
        invalid = [
            (None, "문자열 형식"), ("", "JSON 형식"), (secret, "JSON 형식"),
            ('{"translation": "' + secret, "JSON 형식"),
            ('{"translation": "first", "translation": "' + secret + '"}', "JSON 형식"),
            (json.dumps(secret), "translation 문자열"),
            (json.dumps([secret]), "translation 문자열"),
            (json.dumps({}), "translation 문자열"),
            (json.dumps({"translation": None}), "translation 문자열"),
            (json.dumps({"translation": 123}), "translation 문자열"),
            (json.dumps({"translation": {"nested": secret}}), "translation 문자열"),
            (json.dumps({"wrong": secret}), "translation 문자열"),
            (json.dumps({"translation": "번역", "note": secret}), "translation 문자열"),
            (json.dumps({"translation": "   "}), "빈 결과"),
            (json.dumps({"translation": "<think>" + secret}), "올바르지 않"),
            (json.dumps({"translation": secret * 100}), "지나치게 길"),
        ]
        for body, message in invalid:
            with self.subTest(body=body):
                post = self.mock_ollama([
                    self.ollama_response({"done": False, "response": secret}),
                    self.ollama_response({"done": False, "response": secret}),
                    self.ollama_response({"done": True, "done_reason": "stop", "response": body}),
                ])
                translator = generate.OllamaTranslator("ja", sleep=lambda seconds: None)
                with self.assertRaises(generate.LocalTranslationError) as caught:
                    translator.translate("hello")
                self.assertIn(message, str(caught.exception))
                self.assertNotIn(secret, str(caught.exception))
                self.assertEqual(post.call_count, 3)

    def test_ollama_valid_structured_json_still_requires_complete_untruncated_response(self):
        for final, message in (({"done": False}, "완료되지 않은"),
                               ({"done": True, "done_reason": "length"}, "출력 한도")):
            with self.subTest(final=final):
                post = self.mock_ollama([
                    self.ollama_response({"done": False}), self.ollama_response({"done": False}),
                    self.ollama_response({**final, "response": '{"translation": "부분 번역"}'}),
                ])
                translator = generate.OllamaTranslator("ja", sleep=lambda seconds: None)
                with self.assertRaisesRegex(generate.LocalTranslationError, message):
                    translator.translate("hello")
                self.assertEqual(post.call_count, 3)

    @patch.object(generate, "emit")
    def test_local_retry_progress_preserves_completed_prefix_and_checkpoints_once(self, emit):
        class TooManyRequests(Exception):
            pass
        class Cloud:
            def __init__(self, *args, **kwargs):
                pass
            def translate(self, text):
                raise TooManyRequests()
        source = [generate.Cue(index, index + .5, "first") for index in range(149)]
        source.append(generate.Cue(149, 150, "お" + "ぉ" * 166))
        completed = [generate.Cue(cue.start, cue.end, "첫째") for cue in source[:-1]]
        saved = []
        post = self.mock_ollama([
            self.ollama_response({"done": False, "response": "부분 번역"}),
            self.ollama_response({"done": True, "response": "오오!"}),
        ])
        result = generate.translate_cues(source, "ja", Cloud, sleep=lambda seconds: None,
                                        completed=completed, on_cue=saved.append)
        self.assertEqual(result[:149], completed)
        self.assertEqual(saved, [generate.Cue(149, 150, "오오!")])
        retry_events = [call.kwargs for call in emit.call_args_list if "재시도" in call.kwargs.get("message", "")]
        self.assertEqual(len(retry_events), 1)
        self.assertEqual(retry_events[0]["percent"], 99)
        self.assertIn("150/150", retry_events[0]["message"])
        self.assertEqual(post.call_count, 2)
        self.assertEqual(source[-1].text, "お" + "ぉ" * 166)

    @patch.object(generate, "emit")
    def test_worker_failed_last_local_cue_retains_149_checkpoint_then_resumes_only_last(self, emit):
        class TooManyRequests(Exception):
            pass
        class Cloud:
            calls = []
            def __init__(self, *args, **kwargs):
                pass
            def translate(self, text):
                self.calls.append(text)
                raise TooManyRequests()
        repeated = "お" + "ぉ" * 166
        post = self.mock_ollama([self.ollama_response({"done": False, "response": "部分"}) for _ in range(3)])
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            args = self.worker_args(output, translate_ko=True, resume=True)
            args.cloud_translation_bridge, args.cloud_translation_client = True, None
            identity = generate.checkpoint_identity(Path(args.audio), args, 10)
            state = generate.load_checkpoint(output, identity, True)
            cues = [generate.Cue(index * .05, (index + 1) * .05, f"line {index}") for index in range(150)]
            cues[-1] = generate.Cue(cues[-1].start, cues[-1].end, repeated)
            prefix = [{"start": cue.start, "end": cue.end, "text": "한국어"} for cue in cues[:-1]]
            state.update(language="ja", transcription_complete=True, transcribed_until=10,
                         cues=[generate.asdict(cue) for cue in cues], translated=prefix)
            generate.save_checkpoint(output, state)
            factory = generate.OllamaTranslator
            with patch.object(generate, "load_dependencies", side_effect=AssertionError("Whisper must not load")), \
                 patch.object(generate, "CloudTranslator", Cloud), \
                 patch.object(generate, "OllamaTranslator", side_effect=lambda language, **kwargs: factory(language, sleep=lambda seconds: None)):
                generate.run(args)
                failed = json.loads((output / "checkpoint.json").read_text())
                self.assertEqual(failed["translated"], prefix)
                self.assertEqual(failed["cues"], state["cues"])
                self.assertFalse((output / "ko.srt").exists())
                self.assertIn("150/150", emit.call_args.kwargs["translationError"])
                self.assertIn("완료되지 않은", emit.call_args.kwargs["translationError"])
                original = (output / "original.srt").read_bytes()
                post.side_effect = [self.ollama_response({"done": True, "done_reason": "stop", "response": "오오!"})]
                generate.run(args)
            resumed = json.loads((output / "checkpoint.json").read_text())
            self.assertEqual(resumed["translated"][:149], prefix)
            self.assertEqual(len(resumed["translated"]), 150)
            self.assertEqual(resumed["translated"][-1], {"start": cues[-1].start, "end": cues[-1].end, "text": "오오!"})
            self.assertEqual(resumed["cues"], state["cues"])
            self.assertEqual((output / "original.srt").read_bytes(), original)
            self.assertEqual(emit.call_args.kwargs["translated"], "ko.srt")
            self.assertEqual(post.call_count, 4)
            self.assertEqual(Cloud.calls, [repeated, repeated])

    @patch.object(generate, "emit")
    def test_worker_mid_translation_failure_preserves_207_and_resumes_208_through_834(self, emit):
        class TooManyRequests(Exception):
            pass
        class Cloud:
            calls = []
            def __init__(self, *args, **kwargs):
                pass
            def translate(self, text):
                self.calls.append(text)
                raise TooManyRequests()
        repeated = "いや" * 167
        post = self.mock_ollama([self.ollama_response({"done": False, "response": "부분 번역"}) for _ in range(3)])
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            args = self.worker_args(output, translate_ko=True, resume=True)
            args.cloud_translation_bridge, args.cloud_translation_client = True, None
            identity = generate.checkpoint_identity(Path(args.audio), args, 10)
            state = generate.load_checkpoint(output, identity, True)
            cues = [generate.Cue(index / 100, (index + 1) / 100, f"line {index + 1}") for index in range(834)]
            cues[207] = generate.Cue(cues[207].start, cues[207].end, repeated)
            expected = [{"start": cue.start, "end": cue.end, "text": f"번역 {index + 1}"}
                        for index, cue in enumerate(cues)]
            prefix = expected[:207]
            state.update(language="ja", transcription_complete=True, transcribed_until=10,
                         cues=[generate.asdict(cue) for cue in cues], translated=prefix)
            generate.save_checkpoint(output, state)
            factory = generate.OllamaTranslator
            with patch.object(generate, "load_dependencies", side_effect=AssertionError("Whisper must not load")), \
                 patch.object(generate, "CloudTranslator", Cloud), \
                 patch.object(generate, "OllamaTranslator", side_effect=lambda language, **kwargs: factory(language, sleep=lambda seconds: None)):
                generate.run(args)
                failed = json.loads((output / "checkpoint.json").read_text())
                self.assertEqual(failed["translated"], prefix)
                self.assertEqual(failed["cues"], state["cues"])
                self.assertIn("208/834", emit.call_args.kwargs["translationError"])
                self.assertFalse((output / "ko.srt").exists())
                self.assertEqual(post.call_count, 3)
                original = (output / "original.srt").read_bytes()
                post.side_effect = [self.ollama_response({"done": True, "done_reason": "stop", "response": cue["text"]})
                                    for cue in expected[207:]]
                generate.run(args)
            resumed = json.loads((output / "checkpoint.json").read_text())
            self.assertEqual(resumed["translated"], expected)
            self.assertEqual(resumed["cues"], state["cues"])
            self.assertEqual((output / "original.srt").read_bytes(), original)
            self.assertEqual(emit.call_args.kwargs["translated"], "ko.srt")
            self.assertEqual(emit.call_args.kwargs["cueCount"], 834)
            self.assertEqual(post.call_count, 3 + 834 - 207)
            prompts = [call.kwargs["json"]["prompt"].split("<subtitle>\n", 1)[1].rsplit("\n</subtitle>", 1)[0]
                       for call in post.call_args_list]
            self.assertEqual(prompts[:3], [repeated, "いや" * 3, "いや" * 3])
            self.assertEqual(prompts[3:], [cue.text for cue in cues[207:]])
            self.assertEqual(Cloud.calls, [repeated, repeated])
            original_times = [line for line in original.decode("utf-8").splitlines() if " --> " in line]
            korean_times = [line for line in (output / "ko.srt").read_text().splitlines() if " --> " in line]
            self.assertEqual(len(korean_times), 834)
            self.assertEqual(korean_times, original_times)

    @patch.object(generate, "emit")
    def test_worker_structured_failure_preserves_checkpoint_and_original_for_resume(self, emit):
        class TooManyRequests(Exception):
            pass
        class Cloud:
            def __init__(self, *args, **kwargs):
                pass
            def translate(self, text):
                raise TooManyRequests()
        post = self.mock_ollama([
            self.ollama_response({"done": True, "done_reason": "length", "response": "잘린 번역"}),
            self.ollama_response({"done": True, "done_reason": "length", "response": "잘린 번역"}),
            self.ollama_response({"done": True, "response": '{"translation": "번역", "note": "PRIVATE RESPONSE"}'}),
        ])
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            args = self.worker_args(output, translate_ko=True, resume=True)
            args.cloud_translation_bridge, args.cloud_translation_client = True, None
            identity = generate.checkpoint_identity(Path(args.audio), args, 10)
            state = generate.load_checkpoint(output, identity, True)
            source = [generate.Cue(0, 1, "first"), generate.Cue(2, 3, "普通の文です。")]
            prefix = [{"start": 0, "end": 1, "text": "첫째"}]
            state.update(language="ja", transcription_complete=True, transcribed_until=10,
                         cues=[generate.asdict(cue) for cue in source], translated=prefix)
            generate.save_checkpoint(output, state)
            factory = generate.OllamaTranslator
            with patch.object(generate, "load_dependencies", side_effect=AssertionError("Whisper must not load")), \
                 patch.object(generate, "CloudTranslator", Cloud), \
                 patch.object(generate, "OllamaTranslator", side_effect=lambda language, **kwargs: factory(language, sleep=lambda seconds: None)):
                generate.run(args)
                failed = json.loads((output / "checkpoint.json").read_text())
                self.assertEqual(failed["translated"], prefix)
                self.assertEqual(failed["cues"], state["cues"])
                self.assertFalse((output / "ko.srt").exists())
                self.assertIn("translation 문자열", emit.call_args.kwargs["translationError"])
                self.assertIn("2/2", emit.call_args.kwargs["translationError"])
                self.assertNotIn("PRIVATE RESPONSE", emit.call_args.kwargs["translationError"])
                original = (output / "original.srt").read_bytes()
                post.side_effect = [
                    self.ollama_response({"done": False, "response": "부분 번역"}),
                    self.ollama_response({"done": False, "response": "부분 번역"}),
                    self.ollama_response({"done": True, "done_reason": "stop", "response": '{"translation": "평범한 문장입니다."}'}),
                ]
                generate.run(args)
            resumed = json.loads((output / "checkpoint.json").read_text())
            self.assertEqual(resumed["translated"], prefix + [{"start": 2, "end": 3, "text": "평범한 문장입니다."}])
            self.assertEqual(resumed["cues"], state["cues"])
            self.assertEqual((output / "original.srt").read_bytes(), original)
            self.assertEqual(emit.call_args.kwargs["translated"], "ko.srt")
            self.assertEqual(post.call_count, 6)
            for call in post.call_args_list:
                self.assertIn(source[1].text, call.kwargs["json"]["prompt"])
            self.assertIn("00:00:02,000 --> 00:00:03,000\n평범한 문장입니다.", (output / "ko.srt").read_text())


if __name__ == "__main__":
    unittest.main()

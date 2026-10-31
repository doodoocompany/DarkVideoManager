"""Local HTTP/worker regressions for #90. No model, Cloud API or downloads."""
from contextlib import contextmanager, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import io
import os
from pathlib import Path
import subprocess
import runpy
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import wave

import requests
from urllib3.exceptions import ReadTimeoutError
import generate


def event(text="", done=False, **extra):
    return (json.dumps({"response": text, "done": done, **extra}, ensure_ascii=False) + "\n").encode("utf-8")


def response(chunks):
    result = Mock()
    result.iter_content.side_effect = lambda **kwargs: iter(chunks)
    return result


@contextmanager
def server(frames):
    """Serve actual chunked HTTP with a caller-supplied bounded response plan."""
    state = SimpleNamespace(requests=[], started=threading.Event())

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def do_GET(self):
            body = json.dumps({"models": [{"name": "qwen3:8b"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            state.requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            state.started.set()
            try:
                for delay, data in frames():
                    time.sleep(delay)
                    self.wfile.write(f"{len(data):X}\r\n".encode() + data + b"\r\n")
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                self.close_connection = True

    http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    state.url = f"http://127.0.0.1:{http.server_port}"
    try:
        yield state
    finally:
        http.shutdown()
        http.server_close()
        thread.join(timeout=2)


@unittest.skipIf(os.name == "nt", "The local translation worker runs in WSL")
class OllamaStreamTests(unittest.TestCase):
    def translator(self, **kwargs):
        tags = Mock()
        tags.json.return_value = {"models": [{"name": "qwen3:8b"}]}
        with patch.object(requests, "get", return_value=tags):
            return generate.OllamaTranslator("ja", sleep=lambda seconds: None, **kwargs)

    def test_slow_generation_outlives_read_timeout_while_chunks_keep_arriving(self):
        def frames():
            for text in ["안", "녕", "하", "세", "요"]:
                yield .07, event(text)
            yield .07, event(done=True, done_reason="stop")

        activity = Mock()
        with server(frames) as http, patch.object(generate.OllamaTranslator, "URL", http.url):
            translator = generate.OllamaTranslator("ja", on_activity=activity)
            # Scale seconds down while retaining the real socket/read behavior.
            translator.READ_TIMEOUT_SECONDS = .3
            started = time.monotonic()
            self.assertEqual(translator.translate("hello"), "안녕하세요")
            self.assertGreater(time.monotonic() - started, .3)
            self.assertEqual(len(http.requests), 1)
            self.assertIs(http.requests[0]["stream"], True)
            self.assertIs(http.requests[0]["think"], False)
            self.assertEqual(activity.call_args_list[0].args, (False,))
            self.assertIn((True,), [call.args for call in activity.call_args_list])

    def test_stalled_stream_retries_with_timeout_diagnostic_and_no_partial_result(self):
        def frames():
            yield 0, event("PRIVATE PARTIAL TEXT")
            yield .4, event(done=True)

        with server(frames) as http, patch.object(generate.OllamaTranslator, "URL", http.url):
            translator = generate.OllamaTranslator("ja", sleep=lambda seconds: None)
            translator.READ_TIMEOUT_SECONDS = .1
            with self.assertRaisesRegex(generate.LocalTranslationError, "응답 시간이 초과.*3회") as caught:
                translator.translate("hello")
            self.assertNotIn("PRIVATE", str(caught.exception))
            self.assertEqual(len(http.requests), 3)

    def test_total_deadline_stops_a_continuously_active_stream(self):
        def frames():
            for _ in range(100):
                yield .01, event("가")

        with server(frames) as http, patch.object(generate.OllamaTranslator, "URL", http.url):
            translator = generate.OllamaTranslator("ja", sleep=lambda seconds: None)
            translator.READ_TIMEOUT_SECONDS = .3
            translator.ATTEMPT_TIMEOUT_SECONDS = .5
            with self.assertRaisesRegex(generate.LocalTranslationError, "응답 시간이 초과.*3회"):
                translator.translate("hello")
            self.assertEqual(len(http.requests), 3)

    def test_utf8_and_structured_json_can_span_network_chunks_without_final_newline(self):
        data = event('{"translation": "안') + event('녕하세요"}', done=True, done_reason="stop").rstrip(b"\n")
        chunks = [data[index:index + 1] for index in range(len(data))]
        result = response(chunks)
        translator = self.translator()
        with patch.object(requests, "post", return_value=result):
            self.assertEqual(translator.translate_once("hello", "hello", 512, structured=True), "안녕하세요")
        result.close.assert_called_once()

    def test_stream_errors_after_partial_text_never_return_it_or_leak_bodies(self):
        for final, message in [
            (b"not-json PRIVATE\n", "JSON 응답"),
            (b'[]\n', "JSON 응답"),
            (event(error="PRIVATE"), "요청을 처리하지 못"),
            (event("PRIVATE", done=True, done_reason="length"), "출력 한도"),
            (event(done="true"), "완료되지 않은"),
            (event(text=5, done=True), "문자열 형식"),
            (b"", "완료되지 않은"),
        ]:
            with self.subTest(final=final):
                result = response([event("PRIVATE"), final])
                translator = self.translator()
                with patch.object(requests, "post", return_value=result), self.assertRaisesRegex(generate.LocalTranslationError, message) as caught:
                    translator.translate_once("hello", "hello", 512)
                self.assertNotIn("PRIVATE", str(caught.exception))
                result.close.assert_called_once()

    def test_stream_frame_total_bytes_and_accumulated_text_are_bounded(self):
        cases = [
            ("MAX_EVENT_BYTES", 32, [b"a" * 33]),
            ("MAX_STREAM_BYTES", 32, [b" " * 33]),
            ("MAX_RESPONSE_CHARS", 5, [event("abcd"), event("ef", done=True)]),
        ]
        for field, limit, chunks in cases:
            with self.subTest(field=field):
                translator = self.translator()
                setattr(translator, field, limit)
                result = response(chunks)
                with patch.object(requests, "post", return_value=result), self.assertRaisesRegex(generate.LocalTranslationError, "크기 한도"):
                    translator.translate_once("hello", "hello", 512)
                result.close.assert_called_once()

    def test_worker_preserves_checkpoint_after_stall_and_resumes_only_unfinished_cue(self):
        def stalled(**kwargs):
            yield event("PRIVATE PARTIAL TEXT")
            raise requests.exceptions.ConnectionError(ReadTimeoutError(None, None, "PRIVATE"))

        failed = response([])
        failed.iter_content.side_effect = stalled
        completed = response([event("둘"), event("째", done=True)])
        factory = generate.OllamaTranslator
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            audio = output / "audio.wav"
            with wave.open(str(audio), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(16000)
                wav.writeframes(b"\0\0" * 16000)
            args = SimpleNamespace(audio=str(audio), output=directory, model="base", language="auto", translate_ko=True, resume=True)
            state = generate.load_checkpoint(output, generate.checkpoint_identity(audio, args, 1), True)
            original_cues = [{"start": 0, "end": .5, "text": "first"}, {"start": .5, "end": 1, "text": "second"}]
            prefix = [{"start": 0, "end": .5, "text": "첫째"}]
            state.update(language="en", transcription_complete=True, transcribed_until=1, cues=original_cues, translated=prefix)
            generate.save_checkpoint(output, state)
            tags = Mock()
            tags.json.return_value = {"models": [{"name": "qwen3:8b"}]}
            with patch.object(generate, "emit") as emit, \
                 patch.object(generate, "load_dependencies", side_effect=AssertionError("Do not repeat ASR")), \
                 patch.object(requests, "get", return_value=tags), \
                 patch.object(requests, "post", side_effect=[failed, failed, failed, completed]) as post, \
                 patch.object(generate, "OllamaTranslator", side_effect=lambda language, **kwargs: factory(language, **{**kwargs, "sleep": lambda seconds: None})):
                generate.run(args)
                self.assertEqual(json.loads((output / "checkpoint.json").read_text())["translated"], prefix)
                self.assertFalse((output / "ko.srt").exists())
                self.assertIn("응답 시간이 초과", emit.call_args.kwargs["translationError"])
                original = (output / "original.srt").read_bytes()
                generate.run(args)
            resumed = json.loads((output / "checkpoint.json").read_text())
            self.assertEqual(resumed["translated"], prefix + [{"start": .5, "end": 1, "text": "둘째"}])
            self.assertEqual(resumed["cues"], original_cues)
            self.assertEqual((output / "original.srt").read_bytes(), original)
            self.assertIn("둘째", (output / "ko.srt").read_text())
            self.assertEqual(post.call_count, 4)
            failed.close.assert_called()

    def test_stdin_eof_cancels_worker_waiting_on_stream(self):
        def frames():
            yield 0, event("partial")
            yield .5, event(done=True)

        with server(frames) as http:
            script = (
                "import generate; "
                f"generate.OllamaTranslator.URL={http.url!r}; "
                "\nwith generate.cancel_on_stdin_close(): generate.OllamaTranslator('ja').translate('hello')"
            )
            with subprocess.Popen([sys.executable, "-B", "-c", script], cwd=Path(__file__).parent,
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as child:
                try:
                    self.assertTrue(http.started.wait(timeout=5))
                    child.stdin.close()
                    self.assertEqual(child.wait(timeout=3), 130)
                finally:
                    if child.poll() is None:
                        child.kill()
                        child.wait(timeout=3)

    def test_numeric_smoke_observes_final_stream_metadata_without_consuming_it_twice(self):
        def frames():
            yield 0, event("네")
            yield 0, event(done=True, done_reason="stop", eval_count=2)

        script = Path(__file__).resolve().parents[2] / "scripts/smoke-subtitle-numeric.py"
        with tempfile.TemporaryDirectory() as directory, server(frames) as http, \
             patch.object(generate.OllamaTranslator, "URL", http.url), \
             patch.object(sys, "argv", [str(script), "--report", str(Path(directory) / "report.json")]), \
             redirect_stdout(io.StringIO()):
            original_post = requests.post
            try:
                runpy.run_path(str(script), run_name="__main__")
            finally:
                requests.post = original_post
            report = json.loads((Path(directory) / "report.json").read_text())
            self.assertIs(report["passed"], True)
            self.assertEqual(report["requests"], [{"input_characters": 2, "done": True, "done_reason": "stop", "eval_count": 2}])


if __name__ == "__main__":
    unittest.main()

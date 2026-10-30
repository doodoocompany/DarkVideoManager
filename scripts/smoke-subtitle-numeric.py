"""Read-only local Ollama regression for long numeric subtitle enumerations.

Run with the managed WSL Python. Google is never used. Optional --checkpoint
reads one existing cue without changing the checkpoint or its subtitle files.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import time


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", type=Path, default=root / "resources/subtitles/generate.py")
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--cue", type=int, default=15)
    parser.add_argument("--report", type=Path, default=root / "test-results/subtitle-numeric.json")
    args = parser.parse_args()
    sys.path.insert(0, str(args.worker.resolve().parent))
    import generate

    before = None
    completed = None
    if args.checkpoint:
        before = args.checkpoint.read_bytes()
        state = json.loads(before)
        source = state["cues"][args.cue - 1]["text"]
        language = state["language"]
        completed = len(state["translated"])
    else:
        source = "はい、1、2、3、2、3、2、" + "1、2、" * 50 + "1"
        language = "ja"

    pattern = r"[0-9０-９]+(?:[ \t]*[,、][ \t]*[0-9０-９]+){7,}"
    lists = re.findall(pattern, source)
    assert lists, "The selected cue must contain a long integer enumeration"
    translator = generate.OllamaTranslator(language)
    original_post = translator.requests.post
    original_read_stream = translator.read_stream
    requests = []

    def observed_post(*positional, **keyword):
        requests.append({
            "input_characters": len(keyword["json"]["prompt"].split("<subtitle>\n", 1)[1].rsplit("\n</subtitle>", 1)[0]),
        })
        return original_post(*positional, **keyword)

    def observed_read_stream(response):
        result = original_read_stream(response)
        requests[-1].update({
            "done": result.get("done"),
            "done_reason": result.get("done_reason"),
            "eval_count": result.get("eval_count"),
        })
        return result

    translator.requests.post = observed_post
    translator.read_stream = observed_read_stream
    started = time.monotonic()
    translated = translator.translate(source)
    assert re.search("[가-힣]", translated), "Natural-language prefix was not translated to Korean"
    assert re.findall(pattern, translated) == lists, "Numeric lists or separators changed"
    assert re.findall(r"[0-9０-９]+", translated) == re.findall(r"[0-9０-９]+", source)
    assert requests and all(item["done"] and item["done_reason"] != "length" for item in requests)
    assert max(item["input_characters"] for item in requests) < len(source), "Numeric list reached the model"
    if args.checkpoint:
        assert args.checkpoint.read_bytes() == before, "Source checkpoint changed during the read-only test"
    report = {
        "passed": True,
        "source_characters": len(source),
        "translation_characters": len(translated),
        "numeric_items_preserved": len(re.findall(r"[0-9０-９]+", source)),
        "completed_translations_untouched": completed,
        "checkpoint_unchanged": before is not None,
        "elapsed_seconds": round(time.monotonic() - started, 2),
        "requests": requests,
        "worker_sha256": hashlib.sha256(args.worker.read_bytes()).hexdigest(),
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()

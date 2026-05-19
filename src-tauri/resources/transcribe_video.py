from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


FILENAME_STAMPS = [
    re.compile(r"(\d{4})-(\d{2})-(\d{2})\s+(\d{2})-(\d{2})-(\d{2})"),
    re.compile(r"(\d{6})_(\d{6})"),
]


@dataclass
class Segment:
    start: float
    end: float
    text: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe video files with faster-whisper.")
    parser.add_argument("input_paths", nargs="+", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--model", default="base")
    parser.add_argument("--language", default=None)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="auto")
    parser.add_argument("--beam-size", type=int, default=5)
    return parser.parse_args()


def collapse_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def parse_recorded_at(file_name: str) -> str | None:
    for pattern in FILENAME_STAMPS:
        match = pattern.search(file_name)
        if not match:
            continue
        try:
            if len(match.groups()) == 6:
                return datetime(
                    int(match.group(1)),
                    int(match.group(2)),
                    int(match.group(3)),
                    int(match.group(4)),
                    int(match.group(5)),
                    int(match.group(6)),
                ).isoformat()
            return datetime.strptime("".join(match.groups()), "%y%m%d%H%M%S").isoformat()
        except ValueError:
            return None
    return None


def format_timestamp(seconds: float) -> str:
    total_ms = max(0, int(round(seconds * 1000)))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, milliseconds = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d}.{milliseconds:03d}"


def format_srt_timestamp(seconds: float) -> str:
    return format_timestamp(seconds).replace(".", ",")


def transcript_md(metadata: dict, segments: list[Segment], transcript: str) -> str:
    lines = [
        f"# Transcript: {metadata['title']}",
        "",
        "## Metadata",
        f"- Source file: `{metadata['source_file']}`",
        f"- Recording timestamp: `{metadata.get('recorded_at') or 'unknown'}`",
        f"- Model: `{metadata.get('model') or 'unknown'}`",
        f"- Language: `{metadata.get('language') or 'auto'}`",
        "",
        "## Full Transcript",
        "",
        transcript.strip() or "_No transcript text generated._",
        "",
        "## Timestamped Segments",
        "",
    ]
    for segment in segments:
        lines.append(
            f"- [{format_timestamp(segment.start)} - {format_timestamp(segment.end)}] {collapse_whitespace(segment.text)}"
        )
    lines.append("")
    return "\n".join(lines)


def srt_text(segments: list[Segment]) -> str:
    blocks = []
    for index, segment in enumerate(segments, start=1):
        blocks.append(
            "\n".join(
                [
                    str(index),
                    f"{format_srt_timestamp(segment.start)} --> {format_srt_timestamp(segment.end)}",
                    collapse_whitespace(segment.text),
                ]
            )
        )
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def load_whisper_model(model_name: str, device: str, compute_type: str):
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise RuntimeError(
            "faster-whisper is not installed. Install it with: python -m pip install faster-whisper"
        ) from exc

    effective_compute_type = compute_type
    if compute_type == "auto":
        effective_compute_type = "int8" if device == "cpu" else "float16"
    return WhisperModel(model_name, device=device, compute_type=effective_compute_type)


def transcribe_file(model, input_path: Path, language: str | None, beam_size: int) -> tuple[list[Segment], str, str | None]:
    result, info = model.transcribe(str(input_path), language=language, beam_size=beam_size)
    segments = [Segment(start=segment.start, end=segment.end, text=segment.text) for segment in result]
    transcript = collapse_whitespace(" ".join(segment.text for segment in segments))
    detected_language = getattr(info, "language", None)
    return segments, transcript, detected_language


def output_paths(output_dir: Path, input_path: Path) -> dict[str, Path]:
    stem = input_path.stem.strip()
    return {
        "markdown": output_dir / f"{stem}.transcript.md",
        "srt": output_dir / f"{stem}.srt",
        "json": output_dir / f"{stem}.json",
    }


def main() -> int:
    args = parse_args()
    input_paths = [path.resolve() for path in args.input_paths]
    missing = [path for path in input_paths if not path.is_file()]
    if missing:
        for path in missing:
            print(f"Input file not found: {path}", file=sys.stderr)
        return 1

    args.output_dir.mkdir(parents=True, exist_ok=True)
    try:
        model = load_whisper_model(args.model, args.device, args.compute_type)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        if args.device != "cpu":
            print("Tip: if CUDA libraries are missing, rerun with --device cpu.", file=sys.stderr)
        return 2

    for input_path in input_paths:
        paths = output_paths(args.output_dir, input_path)
        print(f"Transcribing {input_path.name} ...")
        segments, transcript, detected_language = transcribe_file(
            model=model,
            input_path=input_path,
            language=args.language,
            beam_size=args.beam_size,
        )
        metadata = {
            "title": input_path.stem.strip(),
            "source_file": input_path.name,
            "recorded_at": parse_recorded_at(input_path.name),
            "model": args.model,
            "language": args.language or detected_language,
        }
        paths["markdown"].write_text(transcript_md(metadata, segments, transcript), encoding="utf-8")
        paths["srt"].write_text(srt_text(segments), encoding="utf-8")
        paths["json"].write_text(
            json.dumps(
                {
                    "metadata": metadata,
                    "transcript": transcript,
                    "segments": [segment.__dict__ for segment in segments],
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"Wrote transcript: {paths['markdown']}")
        print(f"Wrote captions: {paths['srt']}")
        print(f"Wrote data: {paths['json']}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

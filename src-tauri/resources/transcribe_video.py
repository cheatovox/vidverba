from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


DEFAULT_MODEL = "medium"
DEFAULT_BEAM_SIZE = 5
DEFAULT_VAD_MIN_SILENCE_MS = 500
DEFAULT_HALLUCINATION_SILENCE_THRESHOLD = 1.0
DEFAULT_SILENCE_THRESHOLD_DB = -39.0
DEFAULT_SILENCE_MIN_SECONDS = 0.2

FILENAME_STAMPS = [
    re.compile(r"(\d{4})-(\d{2})-(\d{2})\s+(\d{2})-(\d{2})-(\d{2})"),
    re.compile(r"(\d{6})_(\d{6})"),
]


@dataclass
class Word:
    start: float
    end: float
    word: str
    probability: float | None

    def to_json(self) -> dict[str, Any]:
        return {
            "start": round_seconds(self.start),
            "end": round_seconds(self.end),
            "word": self.word,
            "probability": round_probability(self.probability),
        }


@dataclass
class Validation:
    status: str
    reasons: list[str]
    silent_duration: float | None
    silent_percent: float | None
    leading_silence: float | None
    mean_word_probability: float | None

    def to_json(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "reasons": self.reasons,
            "silentDuration": round_seconds(self.silent_duration),
            "silentPercent": round_probability(self.silent_percent),
            "leadingSilence": round_seconds(self.leading_silence),
            "meanWordProbability": round_probability(self.mean_word_probability),
        }


@dataclass
class Segment:
    start: float
    end: float
    text: str
    avg_logprob: float | None
    compression_ratio: float | None
    no_speech_prob: float | None
    temperature: float | None
    words: list[Word]
    validation: Validation

    def to_json(self) -> dict[str, Any]:
        return {
            "start": round_seconds(self.start),
            "end": round_seconds(self.end),
            "text": self.text,
            "avgLogprob": round_probability(self.avg_logprob),
            "compressionRatio": round_probability(self.compression_ratio),
            "noSpeechProb": round_probability(self.no_speech_prob),
            "temperature": round_probability(self.temperature),
            "words": [word.to_json() for word in self.words],
            "validation": self.validation.to_json(),
        }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe video files with faster-whisper.")
    parser.add_argument("input_paths", nargs="+", type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path("output/video-transcripts"))
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--language", default=None)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--compute-type", default="auto")
    parser.add_argument("--beam-size", type=int, default=DEFAULT_BEAM_SIZE)
    parser.add_argument("--vad-filter", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--vad-min-silence-ms", type=int, default=DEFAULT_VAD_MIN_SILENCE_MS)
    parser.add_argument("--word-timestamps", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument(
        "--condition-on-previous-text",
        action=argparse.BooleanOptionalAction,
        default=False,
    )
    parser.add_argument(
        "--hallucination-silence-threshold",
        type=float,
        default=DEFAULT_HALLUCINATION_SILENCE_THRESHOLD,
    )
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--silence-threshold-db", type=float, default=DEFAULT_SILENCE_THRESHOLD_DB)
    parser.add_argument("--silence-min-seconds", type=float, default=DEFAULT_SILENCE_MIN_SECONDS)
    parser.add_argument("--skip-existing", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
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


def format_timestamp(seconds: float | None) -> str:
    total_ms = max(0, int(round((seconds or 0.0) * 1000)))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, milliseconds = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d}.{milliseconds:03d}"


def format_srt_timestamp(seconds: float) -> str:
    return format_timestamp(seconds).replace(".", ",")


def round_seconds(value: float | None) -> float | None:
    if value is None:
        return None
    return round(max(0.0, float(value)), 3)


def round_probability(value: float | None) -> float | None:
    if value is None:
        return None
    return round(float(value), 4)


def transcript_md(metadata: dict[str, Any], segments: list[Segment], transcript: str) -> str:
    lines = [
        f"# Transcript: {metadata['title']}",
        "",
        "## Metadata",
        f"- Source file: `{metadata['source_file']}`",
        f"- Recording timestamp: `{metadata.get('recorded_at') or 'unknown'}`",
        f"- Model: `{metadata.get('model') or 'unknown'}`",
        f"- Language: `{metadata.get('language') or 'auto'}`",
        f"- Device: `{metadata.get('device') or 'auto'}`",
        f"- VAD filter: `{metadata.get('vad_filter')}`",
        f"- Word timestamps: `{metadata.get('word_timestamps')}`",
        "",
        "## Full Transcript",
        "",
        transcript.strip() or "_No transcript text generated._",
        "",
        "## Timestamped Segments",
        "",
    ]
    if not segments:
        lines.append("_No timestamped segments available._")
    else:
        for segment in segments:
            status = segment.validation.status.upper()
            reasons = "; ".join(segment.validation.reasons)
            suffix = f" ({reasons})" if reasons else ""
            lines.append(
                f"- [{format_timestamp(segment.start)} - {format_timestamp(segment.end)}] [{status}] {collapse_whitespace(segment.text)}{suffix}"
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


def resolve_device(device: str) -> str:
    if device != "auto":
        return device
    return "cuda" if shutil.which("nvidia-smi") else "cpu"


def load_whisper_model(model_name: str, requested_device: str, compute_type: str):
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise RuntimeError(
            "faster-whisper is not installed. Install it with: python -m pip install faster-whisper"
        ) from exc

    device = resolve_device(requested_device)
    if device == "cpu":
        effective_compute_type = "int8" if compute_type == "auto" else compute_type
        return (
            WhisperModel(model_name, device="cpu", compute_type=effective_compute_type),
            "cpu",
            effective_compute_type,
        )

    cuda_compute_types = ["float16"] if compute_type == "auto" else [compute_type]
    if "int8_float16" not in cuda_compute_types:
        cuda_compute_types.append("int8_float16")

    failures: list[str] = []
    for cuda_compute_type in cuda_compute_types:
        try:
            return (
                WhisperModel(model_name, device=device, compute_type=cuda_compute_type),
                device,
                cuda_compute_type,
            )
        except Exception as exc:
            failures.append(f"{device}/{cuda_compute_type}: {exc}")
            print(
                f"CUDA model load failed for {device}/{cuda_compute_type}: {exc}",
                file=sys.stderr,
            )

    print("Falling back to CPU int8 after CUDA failures.", file=sys.stderr)
    try:
        return WhisperModel(model_name, device="cpu", compute_type="int8"), "cpu", "int8"
    except Exception as exc:
        raise RuntimeError(
            "Could not load faster-whisper on CUDA or CPU.\n" + "\n".join(failures)
        ) from exc


def detect_silence_ranges(
    input_path: Path,
    ffmpeg: str,
    threshold_db: float,
    min_silence_seconds: float,
    fallback_end: float,
) -> list[tuple[float, float]] | None:
    executable = ffmpeg if Path(ffmpeg).is_file() else shutil.which(ffmpeg)
    if not executable:
        return None

    filter_text = f"silencedetect=noise={threshold_db}dB:d={min_silence_seconds}"
    command = [
        executable,
        "-hide_banner",
        "-nostats",
        "-i",
        str(input_path),
        "-vn",
        "-af",
        filter_text,
        "-f",
        "null",
        "-",
    ]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, check=False)
    except OSError:
        return None
    if completed.returncode != 0:
        return None

    silences: list[tuple[float, float]] = []
    open_start: float | None = None
    combined = f"{completed.stdout}\n{completed.stderr}"
    for line in combined.splitlines():
        start_match = re.search(r"silence_start:\s*([0-9.]+)", line)
        if start_match:
            open_start = float(start_match.group(1))
        end_match = re.search(r"silence_end:\s*([0-9.]+)", line)
        if end_match and open_start is not None:
            silence_end = float(end_match.group(1))
            if silence_end > open_start:
                silences.append((open_start, silence_end))
            open_start = None
    if open_start is not None and fallback_end > open_start:
        silences.append((open_start, fallback_end))
    return silences


def overlap_duration(start: float, end: float, ranges: list[tuple[float, float]] | None) -> float | None:
    if ranges is None:
        return None
    return sum(max(0.0, min(silence_end, end) - max(silence_start, start)) for silence_start, silence_end in ranges)


def leading_silence_duration(start: float, end: float, ranges: list[tuple[float, float]] | None) -> float | None:
    if ranges is None:
        return None
    for silence_start, silence_end in ranges:
        if silence_start <= start + 0.05 and silence_end > start:
            return max(0.0, min(silence_end, end) - start)
    return 0.0


def mean_word_probability(words: list[Word]) -> float | None:
    probabilities = [word.probability for word in words if word.probability is not None]
    if not probabilities:
        return None
    return sum(probabilities) / len(probabilities)


def validate_segment(
    start: float,
    end: float,
    avg_logprob: float | None,
    compression_ratio: float | None,
    no_speech_prob: float | None,
    words: list[Word],
    silence_ranges: list[tuple[float, float]] | None,
) -> Validation:
    duration = max(0.0, end - start)
    silent_duration = overlap_duration(start, end, silence_ranges)
    silent_percent = (silent_duration / duration * 100.0) if silent_duration is not None and duration > 0 else None
    leading_silence = leading_silence_duration(start, end, silence_ranges)
    mean_probability = mean_word_probability(words)
    reasons: list[str] = []
    status = "ok"

    if silent_percent is not None and silent_percent >= 90.0:
        reasons.append(f"{silent_percent:.0f}% of range is below the silence threshold")
        status = "bad"
    if no_speech_prob is not None and avg_logprob is not None and no_speech_prob >= 0.6 and avg_logprob < -1.0:
        reasons.append("model marked likely no-speech with low token confidence")
        status = "bad"

    warning_reasons: list[str] = []
    if avg_logprob is not None and avg_logprob < -1.0:
        warning_reasons.append("low average token log probability")
    if compression_ratio is not None and compression_ratio > 2.4:
        warning_reasons.append("high compression ratio")
    if mean_probability is not None and mean_probability < 0.5:
        warning_reasons.append("low mean word probability")
    if leading_silence is not None and duration > 0 and leading_silence >= 2.0 and leading_silence / duration >= 0.25:
        warning_reasons.append(f"starts with {leading_silence:.1f}s of silence")
    if status != "bad" and warning_reasons:
        status = "warning"
    reasons.extend(warning_reasons)

    has_metrics = any(
        value is not None
        for value in [
            avg_logprob,
            compression_ratio,
            no_speech_prob,
            silent_percent,
            mean_probability,
        ]
    )
    if not has_metrics:
        status = "unknown"
        reasons.append("no confidence metadata available")

    return Validation(
        status=status,
        reasons=reasons,
        silent_duration=silent_duration,
        silent_percent=silent_percent,
        leading_silence=leading_silence,
        mean_word_probability=mean_probability,
    )


def make_segment(raw_segment: Any, silence_ranges: list[tuple[float, float]] | None) -> Segment:
    words = [
        Word(
            start=getattr(word, "start", 0.0),
            end=getattr(word, "end", 0.0),
            word=getattr(word, "word", ""),
            probability=getattr(word, "probability", None),
        )
        for word in (getattr(raw_segment, "words", None) or [])
    ]
    start = float(getattr(raw_segment, "start", 0.0))
    end = float(getattr(raw_segment, "end", start))
    avg_logprob = getattr(raw_segment, "avg_logprob", None)
    compression_ratio = getattr(raw_segment, "compression_ratio", None)
    no_speech_prob = getattr(raw_segment, "no_speech_prob", None)
    validation = validate_segment(
        start=start,
        end=end,
        avg_logprob=avg_logprob,
        compression_ratio=compression_ratio,
        no_speech_prob=no_speech_prob,
        words=words,
        silence_ranges=silence_ranges,
    )
    return Segment(
        start=start,
        end=end,
        text=getattr(raw_segment, "text", ""),
        avg_logprob=avg_logprob,
        compression_ratio=compression_ratio,
        no_speech_prob=no_speech_prob,
        temperature=getattr(raw_segment, "temperature", None),
        words=words,
        validation=validation,
    )


def transcribe_file(
    model: Any,
    input_path: Path,
    args: argparse.Namespace,
) -> tuple[list[Segment], str, str | None, float | None]:
    result, info = model.transcribe(
        str(input_path),
        language=args.language,
        beam_size=args.beam_size,
        vad_filter=args.vad_filter,
        vad_parameters={"min_silence_duration_ms": args.vad_min_silence_ms},
        word_timestamps=args.word_timestamps,
        condition_on_previous_text=args.condition_on_previous_text,
        hallucination_silence_threshold=args.hallucination_silence_threshold if args.word_timestamps else None,
    )
    raw_segments = list(result)
    fallback_end = max([getattr(segment, "end", 0.0) for segment in raw_segments] + [0.0])
    silence_ranges = detect_silence_ranges(
        input_path=input_path,
        ffmpeg=args.ffmpeg,
        threshold_db=args.silence_threshold_db,
        min_silence_seconds=args.silence_min_seconds,
        fallback_end=fallback_end,
    )
    segments = [make_segment(segment, silence_ranges) for segment in raw_segments]
    transcript = collapse_whitespace(" ".join(segment.text for segment in segments))
    detected_language = getattr(info, "language", None)
    language_probability = getattr(info, "language_probability", None)
    return segments, transcript, detected_language, language_probability


def output_paths(output_dir: Path, input_path: Path) -> dict[str, Path]:
    stem = input_path.stem.strip()
    return {
        "markdown": output_dir / f"{stem}.transcript.md",
        "srt": output_dir / f"{stem}.srt",
        "json": output_dir / f"{stem}.json",
    }


def write_outputs(paths: dict[str, Path], metadata: dict[str, Any], segments: list[Segment], transcript: str) -> None:
    paths["markdown"].write_text(transcript_md(metadata, segments, transcript), encoding="utf-8")
    paths["srt"].write_text(srt_text(segments), encoding="utf-8")
    paths["json"].write_text(
        json.dumps(
            {
                "metadata": metadata,
                "transcript": transcript,
                "segments": [segment.to_json() for segment in segments],
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def main() -> int:
    args = parse_args()
    input_paths = [path.resolve() for path in args.input_paths]
    missing = [path for path in input_paths if not path.is_file()]
    if missing:
        for path in missing:
            print(f"Input file not found: {path}", file=sys.stderr)
        return 1

    args.output_dir.mkdir(parents=True, exist_ok=True)
    if args.dry_run:
        print("Dry run only. Files that would be transcribed:")
        for input_path in input_paths:
            print(f"- {input_path}")
        print(f"Output directory: {args.output_dir.resolve()}")
        return 0

    try:
        model, resolved_device, effective_compute_type = load_whisper_model(args.model, args.device, args.compute_type)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        if args.device != "cpu":
            print("Tip: if CUDA libraries are missing, rerun with --device cpu.", file=sys.stderr)
        return 2

    for input_path in input_paths:
        paths = output_paths(args.output_dir, input_path)
        if args.skip_existing and all(path.exists() for path in paths.values()):
            print(f"Skipping {input_path.name}: transcript outputs already exist.")
            continue

        print(f"Transcribing {input_path.name} with {args.model} on {resolved_device} ...")
        try:
            segments, transcript, detected_language, language_probability = transcribe_file(
                model=model,
                input_path=input_path,
                args=args,
            )
        except Exception as exc:
            if resolved_device == "cpu":
                raise
            print(f"Transcription failed on {resolved_device}: {exc}", file=sys.stderr)
            print("Retrying transcription on CPU int8.", file=sys.stderr)
            model, resolved_device, effective_compute_type = load_whisper_model(args.model, "cpu", "int8")
            segments, transcript, detected_language, language_probability = transcribe_file(
                model=model,
                input_path=input_path,
                args=args,
            )
        metadata = {
            "title": input_path.stem.strip(),
            "source_file": input_path.name,
            "recorded_at": parse_recorded_at(input_path.name),
            "model": args.model,
            "language": args.language or detected_language,
            "language_probability": round_probability(language_probability),
            "device": resolved_device,
            "compute_type": effective_compute_type,
            "beam_size": args.beam_size,
            "vad_filter": args.vad_filter,
            "vad_min_silence_ms": args.vad_min_silence_ms,
            "word_timestamps": args.word_timestamps,
            "condition_on_previous_text": args.condition_on_previous_text,
            "hallucination_silence_threshold": args.hallucination_silence_threshold,
            "silence_threshold_db": args.silence_threshold_db,
        }
        write_outputs(paths, metadata, segments, transcript)
        print(f"Wrote transcript: {paths['markdown']}")
        print(f"Wrote captions: {paths['srt']}")
        print(f"Wrote data: {paths['json']}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

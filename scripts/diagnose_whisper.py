from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path


DLL_NAMES = [
    "cublas64_12.dll",
    "cublasLt64_12.dll",
    "cudart64_12.dll",
    "cudnn64_9.dll",
    "cudnn_ops64_9.dll",
]


def find_on_path(name: str) -> list[str]:
    found: list[str] = []
    for entry in os.environ.get("PATH", "").split(os.pathsep):
        if not entry:
            continue
        candidate = Path(entry) / name
        if candidate.is_file():
            found.append(str(candidate))
    return found


def package_versions() -> dict[str, str]:
    versions: dict[str, str] = {}
    try:
        import faster_whisper

        versions["faster_whisper"] = getattr(faster_whisper, "__version__", "installed")
    except Exception as exc:
        versions["faster_whisper"] = f"ERROR: {exc}"

    try:
        import ctranslate2

        versions["ctranslate2"] = ctranslate2.__version__
        versions["ctranslate2_path"] = str(Path(ctranslate2.__file__).parent)
        versions["ctranslate2_cuda_devices"] = str(ctranslate2.get_cuda_device_count())
    except Exception as exc:
        versions["ctranslate2"] = f"ERROR: {exc}"

    return versions


def try_model(model_name: str, device: str, compute_type: str) -> dict[str, str]:
    try:
        from faster_whisper import WhisperModel

        WhisperModel(model_name, device=device, compute_type=compute_type)
        return {"status": "ok"}
    except Exception as exc:
        return {"status": "failed", "error": repr(exc)}


def main() -> int:
    parser = argparse.ArgumentParser(description="Diagnose faster-whisper CUDA readiness.")
    parser.add_argument("--model", default="tiny")
    args = parser.parse_args()

    report = {
        "python": sys.executable,
        "pythonVersion": sys.version.replace("\n", " "),
        "nvidiaSmi": shutil.which("nvidia-smi"),
        "packages": package_versions(),
        "dllsOnPath": {name: find_on_path(name) for name in DLL_NAMES},
        "modelLoad": {
            "cudaFloat16": try_model(args.model, "cuda", "float16"),
            "cudaInt8Float16": try_model(args.model, "cuda", "int8_float16"),
            "cpuInt8": try_model(args.model, "cpu", "int8"),
        },
    }
    print(json.dumps(report, indent=2))

    cuda_ok = report["modelLoad"]["cudaFloat16"]["status"] == "ok" or report["modelLoad"][
        "cudaInt8Float16"
    ]["status"] == "ok"
    return 0 if cuda_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

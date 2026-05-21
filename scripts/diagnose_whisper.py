from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


CUDA_DLL_PATH_BOOTSTRAP_ENV = "VIDVERBA_CUDA_DLL_PATH_BOOTSTRAPPED"
NVIDIA_DLL_PACKAGE_BINS = [
    Path("nvidia") / "cublas" / "bin",
    Path("nvidia") / "cuda_runtime" / "bin",
    Path("nvidia") / "cudnn" / "bin",
]
DLL_NAMES = [
    "cublas64_12.dll",
    "cublasLt64_12.dll",
    "cudart64_12.dll",
    "cudnn64_9.dll",
    "cudnn_ops64_9.dll",
]


def ensure_cuda_dll_paths() -> None:
    if os.name != "nt" or os.environ.get(CUDA_DLL_PATH_BOOTSTRAP_ENV) == "1":
        return
    try:
        import site
    except Exception:
        return

    site_roots = [Path(path) for path in site.getsitepackages()]
    user_site = site.getusersitepackages()
    if user_site:
        site_roots.append(Path(user_site))

    existing_path = os.environ.get("PATH", "")
    existing_entries = {entry.casefold() for entry in existing_path.split(os.pathsep) if entry}
    dll_dirs: list[str] = []
    for root in site_roots:
        for relative_path in NVIDIA_DLL_PACKAGE_BINS:
            dll_dir = root / relative_path
            dll_dir_text = str(dll_dir)
            if dll_dir.is_dir() and dll_dir_text.casefold() not in existing_entries:
                dll_dirs.append(dll_dir_text)

    if not dll_dirs:
        return

    env = os.environ.copy()
    env["PATH"] = os.pathsep.join(dll_dirs + [existing_path])
    env[CUDA_DLL_PATH_BOOTSTRAP_ENV] = "1"
    result = subprocess.run([sys.executable, *sys.argv], env=env)
    raise SystemExit(result.returncode)


ensure_cuda_dll_paths()


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

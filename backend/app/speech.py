from __future__ import annotations

from functools import lru_cache
from pathlib import Path
import os

import requests
from faster_whisper import WhisperModel
from kokoro_onnx import Kokoro

from .config import settings


KOKORO_MODEL_URL = (
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.onnx"
)
KOKORO_VOICES_URL = (
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin"
)


def _download_file(url: str, destination: Path) -> None:
    if destination.exists() and destination.stat().st_size > 0:
        return

    if destination.exists() and destination.stat().st_size == 0:
        destination.unlink(missing_ok=True)

    response = requests.get(url, timeout=120, stream=True)
    response.raise_for_status()
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp_destination = destination.with_suffix(f"{destination.suffix}.part")
    with temp_destination.open("wb") as handle:
        for chunk in response.iter_content(chunk_size=1024 * 1024):
            if chunk:
                handle.write(chunk)

    if temp_destination.stat().st_size == 0:
        temp_destination.unlink(missing_ok=True)
        raise RuntimeError(f"Downloaded empty asset from {url}")

    os.replace(temp_destination, destination)


def ensure_kokoro_assets() -> None:
    _download_file(KOKORO_MODEL_URL, settings.kokoro_model_path)
    _download_file(KOKORO_VOICES_URL, settings.kokoro_voices_path)


@lru_cache(maxsize=1)
def get_whisper_model() -> WhisperModel:
    return WhisperModel(settings.whisper_model, device="cpu", compute_type="int8")


@lru_cache(maxsize=1)
def get_kokoro() -> Kokoro:
    ensure_kokoro_assets()
    try:
        return Kokoro(str(settings.kokoro_model_path), str(settings.kokoro_voices_path))
    except Exception:
        settings.kokoro_model_path.unlink(missing_ok=True)
        ensure_kokoro_assets()
        return Kokoro(str(settings.kokoro_model_path), str(settings.kokoro_voices_path))


def transcribe_audio(audio_path: Path, language: str | None) -> str:
    model = get_whisper_model()
    segments, _ = model.transcribe(
        str(audio_path),
        beam_size=5,
        language=language or None,
        vad_filter=True,
    )
    transcript = " ".join(segment.text.strip() for segment in segments).strip()
    return transcript


def synthesize_speech(text: str, voice: str, speed: float, lang: str):
    kokoro = get_kokoro()
    samples, sample_rate = kokoro.create(text, voice=voice, speed=speed, lang=lang)
    return samples, sample_rate


def list_available_voices() -> list[str]:
    kokoro = get_kokoro()
    return list(kokoro.get_voices())

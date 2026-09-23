from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]
BACKEND_DIR = ROOT_DIR / "backend"
DATA_DIR = BACKEND_DIR / "data"
MODEL_DIR = BACKEND_DIR / "models"


@dataclass(slots=True)
class Settings:
    ollama_base_url: str = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
    default_chat_model: str = os.getenv("OLLAMA_CHAT_MODEL", "llama3.2:latest")
    embedding_model: str = os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text:latest")
    whisper_model: str = os.getenv("WHISPER_MODEL", "base")
    default_voice: str = os.getenv("KOKORO_VOICE", "af_sarah")
    default_voice_lang: str = os.getenv("KOKORO_LANG", "en-us")
    default_system_prompt: str = os.getenv(
        "DEFAULT_SYSTEM_PROMPT",
        "You are a concise local assistant. Use the retrieved knowledge when it is relevant and say when you are unsure.",
    )
    database_path: Path = Path(os.getenv("KNOWLEDGE_DB_PATH", DATA_DIR / "knowledge.db"))
    chunk_size: int = int(os.getenv("KNOWLEDGE_CHUNK_SIZE", "1200"))
    chunk_overlap: int = int(os.getenv("KNOWLEDGE_CHUNK_OVERLAP", "200"))
    kokoro_model_path: Path = Path(os.getenv("KOKORO_MODEL_PATH", MODEL_DIR / "kokoro-v1.0.onnx"))
    kokoro_voices_path: Path = Path(os.getenv("KOKORO_VOICES_PATH", MODEL_DIR / "voices-v1.0.bin"))


settings = Settings()
DATA_DIR.mkdir(parents=True, exist_ok=True)
MODEL_DIR.mkdir(parents=True, exist_ok=True)

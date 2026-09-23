from __future__ import annotations

import base64
import io
import json
import tempfile
from pathlib import Path

import requests
import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from PyPDF2 import PdfReader
from starlette.responses import StreamingResponse

from .config import settings
from .knowledge import SQLiteVectorStore
from .speech import list_available_voices, synthesize_speech, transcribe_audio


app = FastAPI(title="STT-TTS Local Assistant")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

store = SQLiteVectorStore(settings.database_path)


class ConversationMessage(BaseModel):
    role: str
    content: str = Field(min_length=1)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)
    model: str | None = None
    system_prompt: str = ""
    use_knowledge: bool = True
    top_k: int = Field(default=4, ge=1, le=8)
    history: list[ConversationMessage] = Field(default_factory=list)


class TtsRequest(BaseModel):
    text: str = Field(min_length=1)
    voice: str = settings.default_voice
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    lang: str = settings.default_voice_lang


def ollama_request(endpoint: str, payload: dict, timeout: int = 120) -> dict:
    try:
        response = requests.post(
            f"{settings.ollama_base_url}{endpoint}",
            json=payload,
            timeout=timeout,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Ollama request failed: {exc}") from exc
    return response.json()


def embed_many(texts: list[str]) -> list[list[float]]:
    response = ollama_request(
        "/api/embed",
        {"model": settings.embedding_model, "input": texts},
    )
    embeddings = response.get("embeddings")
    if not isinstance(embeddings, list):
        raise HTTPException(status_code=502, detail="Ollama did not return embeddings.")
    return embeddings


def embed_one(text: str) -> list[float]:
    embeddings = embed_many([text])
    return embeddings[0]


def extract_text(filename: str, content: bytes) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix in {".txt", ".md", ".py", ".json", ".csv"}:
        return content.decode("utf-8", errors="ignore")
    if suffix == ".pdf":
        reader = PdfReader(io.BytesIO(content))
        return "\n".join(page.extract_text() or "" for page in reader.pages)
    raise HTTPException(
        status_code=400,
        detail="Unsupported file type. Upload .txt, .md, .py, .json, .csv, or .pdf.",
    )


def build_system_prompt(system_prompt: str, hits: list[dict[str, str | float]]) -> str:
    base_prompt = system_prompt.strip() or settings.default_system_prompt
    if not hits:
        return base_prompt

    context_lines = []
    for index, hit in enumerate(hits, start=1):
        context_lines.append(f"[{index}] Source: {hit['source_name']}\n{hit['content']}")

    return (
        f"{base_prompt}\n\n"
        "Local knowledge:\n"
        + "\n\n".join(context_lines)
        + "\n\nUse the local knowledge when it helps answer the user accurately."
    )


def generate_reply(
    message: str,
    model: str | None,
    system_prompt: str,
    use_knowledge: bool,
    top_k: int,
    history: list[ConversationMessage] | None = None,
) -> tuple[str, list[dict[str, str | float]]]:
    hits: list[dict[str, str | float]] = []
    if use_knowledge and store.list_documents():
        hits = store.search(message, top_k=top_k, embed_one=embed_one)

    prior_messages = [
        {"role": item.role, "content": item.content}
        for item in (history or [])
        if item.role in {"user", "assistant"} and item.content.strip()
    ]

    response = ollama_request(
        "/api/chat",
        {
            "model": model or settings.default_chat_model,
            "stream": False,
            "messages": [
                {"role": "system", "content": build_system_prompt(system_prompt, hits)},
                *prior_messages,
                {"role": "user", "content": message},
            ],
        },
    )
    reply = response.get("message", {}).get("content", "").strip()
    if not reply:
        raise HTTPException(status_code=502, detail="Ollama returned an empty response.")
    return reply, hits


@app.get("/health")
def health() -> dict[str, str | bool]:
    return {
        "status": "ok",
        "ollama_base_url": settings.ollama_base_url,
        "kokoro_assets_ready": settings.kokoro_model_path.exists() and settings.kokoro_voices_path.exists(),
    }


@app.get("/api/models")
def get_models() -> dict[str, object]:
    try:
        response = requests.get(f"{settings.ollama_base_url}/api/tags", timeout=15)
        response.raise_for_status()
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Unable to reach Ollama: {exc}") from exc
    payload = response.json()
    models = payload.get("models", [])
    return {"models": models}


@app.get("/api/voices")
def get_voices() -> dict[str, object]:
    voices = list_available_voices()
    return {
        "voices": voices,
        "default_voice": settings.default_voice,
        "default_lang": settings.default_voice_lang,
    }


@app.get("/api/knowledge")
def list_knowledge() -> dict[str, object]:
    return {"documents": store.list_documents()}


@app.delete("/api/knowledge/{source_name}")
def delete_knowledge(source_name: str) -> dict[str, str]:
    store.delete_document(source_name)
    return {"status": "deleted"}


@app.post("/api/knowledge")
async def ingest_knowledge(file: UploadFile = File(...)) -> dict[str, object]:
    content = await file.read()
    filename = file.filename or "upload.txt"
    text = extract_text(filename, content)
    chunk_count = store.upsert_document(
        source_name=filename,
        text=text,
        chunk_size=settings.chunk_size,
        overlap=settings.chunk_overlap,
        embed_many=embed_many,
    )
    return {"status": "indexed", "source_name": filename, "chunk_count": chunk_count}


@app.post("/api/chat")
def chat(request: ChatRequest) -> dict[str, object]:
    reply, hits = generate_reply(
        message=request.message,
        model=request.model,
        system_prompt=request.system_prompt,
        use_knowledge=request.use_knowledge,
        top_k=request.top_k,
        history=request.history,
    )
    return {"reply": reply, "sources": hits}


@app.post("/api/stt")
async def stt(file: UploadFile = File(...), language: str | None = Form(default=None)) -> dict[str, str]:
    suffix = Path(file.filename or "recording.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as handle:
        handle.write(await file.read())
        temp_path = Path(handle.name)
    try:
        transcript = transcribe_audio(temp_path, language)
    finally:
        temp_path.unlink(missing_ok=True)

    if not transcript:
        raise HTTPException(status_code=400, detail="No speech was detected in the uploaded audio.")
    return {"transcript": transcript}


@app.post("/api/tts")
def tts(request: TtsRequest):
    samples, sample_rate = synthesize_speech(
        request.text,
        voice=request.voice,
        speed=request.speed,
        lang=request.lang,
    )
    buffer = io.BytesIO()
    sf.write(buffer, samples, sample_rate, format="WAV")
    buffer.seek(0)
    return StreamingResponse(buffer, media_type="audio/wav")


@app.post("/api/speech-to-speech")
async def speech_to_speech(
    file: UploadFile = File(...),
    model: str | None = Form(default=None),
    system_prompt: str = Form(default=""),
    voice: str = Form(default=settings.default_voice),
    voice_lang: str = Form(default=settings.default_voice_lang),
    speech_speed: float = Form(default=1.0),
    use_knowledge: bool = Form(default=True),
    top_k: int = Form(default=4),
    language: str | None = Form(default=None),
    history_json: str = Form(default="[]"),
) -> dict[str, object]:
    suffix = Path(file.filename or "recording.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as handle:
        handle.write(await file.read())
        temp_path = Path(handle.name)

    try:
        transcript = transcribe_audio(temp_path, language)
    finally:
        temp_path.unlink(missing_ok=True)

    if not transcript:
        raise HTTPException(status_code=400, detail="No speech was detected in the uploaded audio.")

    try:
        history = [ConversationMessage.model_validate(item) for item in json.loads(history_json)]
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid conversation history: {exc}") from exc

    reply, hits = generate_reply(
        message=transcript,
        model=model,
        system_prompt=system_prompt,
        use_knowledge=use_knowledge,
        top_k=top_k,
        history=history,
    )
    samples, sample_rate = synthesize_speech(reply, voice=voice, speed=speech_speed, lang=voice_lang)
    buffer = io.BytesIO()
    sf.write(buffer, samples, sample_rate, format="WAV")
    audio_base64 = base64.b64encode(buffer.getvalue()).decode("ascii")

    return {
        "transcript": transcript,
        "reply": reply,
        "audio_base64": audio_base64,
        "mime_type": "audio/wav",
        "sources": hits,
    }
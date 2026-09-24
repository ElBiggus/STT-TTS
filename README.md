# Local Voice Studio

Windows desktop app for a local speech-to-speech workflow:

- Electron desktop shell with a React front end
- Ollama chat and model selection
- Faster-Whisper speech-to-text
- Kokoro ONNX text-to-speech
- SQLite-backed local vector store with Ollama embeddings
- Customizable system prompt and knowledge file upload

## Architecture

- `electron/`: desktop shell that starts the local Python API
- `src/`: React renderer for chat, speech controls, and knowledge management
- `backend/app/`: FastAPI service for Ollama, retrieval, STT, and TTS

## Prerequisites

- Node.js 26+
- Python 3.11 installed and available via `py -3.11`
- A local Ollama server running on `http://127.0.0.1:11434`
- At least one chat model in Ollama and one embedding model such as `nomic-embed-text`

Recommended Ollama pulls:

```powershell
ollama pull llama3.2
ollama pull nomic-embed-text
```

## Setup

Install desktop dependencies:

```powershell
npm install
```

Create the backend virtual environment and install Python packages:

```powershell
npm run setup:backend
```

## Run

Development mode:

```powershell
npm run dev
```

This starts Vite and launches Electron. Electron starts the FastAPI backend automatically.

## Features

- `Record to text`: captures microphone audio and inserts the transcript into the composer
- `Voice roundtrip`: microphone input goes through STT, Ollama, and TTS in a "push-to-talk" flow
- `Hands-freee chat`: microphone input is constanly "listened to", and STT will activate at a "natural pause" allowing for free-flowing conversations
- `Local Knowledge`: upload `.txt`, `.md`, `.pdf`, `.py`, `.json`, or `.csv` files for retrieval
- `System prompt`: edit the assistant behavior live from the UI
- `Model selector`: switches between models exposed by your local Ollama server
- `Open to LAN`: exposes the UI and API on port `8000` to devices on your local network
- `Open to WAN`: exposes the UI and API on port `8000` beyond your local network after firewall and router rules are configured

## Packaging

Build the renderer:

```powershell
npm run build
```

Create a Windows installer shell:

```powershell
npm run dist:win
```

Current packaging note: the installer bundles the frontend and backend source, but still expects a usable Python 3.11 runtime on the target machine.

On installed builds, the app provisions its backend virtual environment on first launch under Electron's user-data directory rather than inside the install folder. On Windows this is typically under `%APPDATA%\STT-Ollama-TTS\backend-runtime`. If startup fails, check `%APPDATA%\STT-Ollama-TTS\backend.log`.

## Backend configuration

These environment variables can be set before launching the app:

- `OLLAMA_BASE_URL`
- `OLLAMA_CHAT_MODEL`
- `OLLAMA_EMBED_MODEL`
- `WHISPER_MODEL`
- `KOKORO_VOICE`
- `KOKORO_LANG`
- `DEFAULT_SYSTEM_PROMPT`
- `FRONTEND_DIST_PATH`

Kokoro model files are downloaded automatically on first TTS use into `backend/models/`.

## Network sharing

The desktop app now includes `Open to LAN` and `Open to WAN` toggles in the session controls.

- `Open to LAN` binds the backend to `0.0.0.0` and creates a Windows Firewall rule limited to `LocalSubnet`.
- `Open to LAN` binds the backend to `0.0.0.0` so other devices on your local network can reach the app.
- `Open to WAN` keeps the same bind address so internet traffic can reach the app too.
- The app does not modify Windows Firewall rules automatically. If clients cannot connect, allow the app or TCP port `8000` manually in Windows Firewall.
- WAN access still requires manual router port forwarding for TCP port `8000` to the machine running the app.

When packaging for Windows, the production frontend is copied into the app resources so remote devices can load the full UI from the backend on port `8000`.

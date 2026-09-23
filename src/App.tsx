import { useEffect, useRef, useState } from 'react'
import './App.css'

const defaultSystemPrompt =
  'You are a concise local assistant. Prefer grounded answers when the knowledge base has relevant context.'

const welcomeMessageContent =
  'Local Voice Studio is ready. Pick an Ollama model, add reference files if you want retrieval, then type or record your request.'

type ModelInfo = {
  name: string
  details?: {
    family?: string
    parameter_size?: string
    quantization_level?: string
  }
}

type KnowledgeDocument = {
  source_name: string
  chunk_count: number
  created_at: string
}

type SourceHit = {
  source_name: string
  content: string
  score: number
}

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources?: SourceHit[]
  localOnly?: boolean
}

type ConversationArchive = {
  version: 1
  exported_at: string
  messages: ChatMessage[]
  settings?: {
    selectedModel?: string
    voice?: string
    voiceLang?: string
    systemPrompt?: string
  }
}

type RecorderMode = 'transcribe' | 'roundtrip' | 'handsfree'

type VoicesResponse = {
  voices: string[]
  default_voice: string
  default_lang: string
}

const apiBaseUrl = window.assistantRuntime?.apiBaseUrl ?? 'http://127.0.0.1:8000'
const storageKeys = {
  selectedModel: 'stt-tts:selected-model',
  voice: 'stt-tts:voice',
  voiceLang: 'stt-tts:voice-lang',
  systemPrompt: 'stt-tts:system-prompt',
  conversation: 'stt-tts:conversation',
} as const

function readStoredValue(key: string, fallback: string) {
  if (typeof window === 'undefined') {
    return fallback
  }

  const storedValue = window.localStorage.getItem(key)
  return storedValue && storedValue.trim() ? storedValue : fallback
}

function createWelcomeMessage(): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: welcomeMessageContent,
    localOnly: true,
  }
}

function sanitizeMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as Partial<ChatMessage>
  if ((candidate.role !== 'user' && candidate.role !== 'assistant') || typeof candidate.content !== 'string') {
    return null
  }

  const trimmedContent = candidate.content.trim()
  if (!trimmedContent) {
    return null
  }

  return {
    id: typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id : crypto.randomUUID(),
    role: candidate.role,
    content: trimmedContent,
    sources: Array.isArray(candidate.sources)
      ? candidate.sources.filter(
          (source): source is SourceHit =>
            Boolean(source) &&
            typeof source === 'object' &&
            typeof source.source_name === 'string' &&
            typeof source.content === 'string' &&
            typeof source.score === 'number',
        )
      : undefined,
  }
}

function readStoredConversation(): ChatMessage[] {
  if (typeof window === 'undefined') {
    return [createWelcomeMessage()]
  }

  try {
    const rawConversation = window.localStorage.getItem(storageKeys.conversation)
    if (!rawConversation) {
      return [createWelcomeMessage()]
    }

    const parsed = JSON.parse(rawConversation) as unknown
    if (!Array.isArray(parsed)) {
      return [createWelcomeMessage()]
    }

    const messages = parsed.map(sanitizeMessage).filter((message): message is ChatMessage => message !== null)
    return messages.length > 0 ? messages : [createWelcomeMessage()]
  } catch {
    return [createWelcomeMessage()]
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, init)
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`
    try {
      const payload = (await response.json()) as { detail?: string }
      if (payload.detail) {
        detail = payload.detail
      }
    } catch {
      // Keep the fallback status text when the response is not JSON.
    }
    throw new Error(detail)
  }

  return (await response.json()) as T
}

function App() {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [voices, setVoices] = useState<string[]>([])
  const [selectedModel, setSelectedModel] = useState(() => readStoredValue(storageKeys.selectedModel, ''))
  const [systemPrompt, setSystemPrompt] = useState(() =>
    readStoredValue(storageKeys.systemPrompt, defaultSystemPrompt),
  )
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>(() => readStoredConversation())
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([])
  const [useKnowledge, setUseKnowledge] = useState(true)
  const [voice, setVoice] = useState(() => readStoredValue(storageKeys.voice, 'af_sarah'))
  const [voiceLang, setVoiceLang] = useState(() => readStoredValue(storageKeys.voiceLang, 'en-us'))
  const [speechSpeed, setSpeechSpeed] = useState(1)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [recording, setRecording] = useState(false)
  const [recordingMode, setRecordingMode] = useState<RecorderMode | null>(null)
  const [handsFreeActive, setHandsFreeActive] = useState(false)
  const [status, setStatus] = useState('Starting local backend…')

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const monitoringFrameRef = useRef<number | null>(null)
  const silenceSinceRef = useRef<number | null>(null)
  const speechDetectedRef = useRef(false)
  const handsFreeActiveRef = useRef(false)
  const playbackAudioRef = useRef<HTMLAudioElement | null>(null)
  const recordingModeRef = useRef<RecorderMode | null>(null)
  const importInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    void bootstrap()
  }, [])

  useEffect(() => {
    handsFreeActiveRef.current = handsFreeActive
  }, [handsFreeActive])

  useEffect(() => {
    recordingModeRef.current = recordingMode
  }, [recordingMode])

  useEffect(() => {
    window.localStorage.setItem(storageKeys.selectedModel, selectedModel)
  }, [selectedModel])

  useEffect(() => {
    window.localStorage.setItem(storageKeys.voice, voice)
  }, [voice])

  useEffect(() => {
    window.localStorage.setItem(storageKeys.voiceLang, voiceLang)
  }, [voiceLang])

  useEffect(() => {
    window.localStorage.setItem(storageKeys.systemPrompt, systemPrompt)
  }, [systemPrompt])

  useEffect(() => {
    const conversation = messages.filter((message) => !message.localOnly)
    if (conversation.length > 0) {
      window.localStorage.setItem(storageKeys.conversation, JSON.stringify(conversation))
      return
    }

    window.localStorage.removeItem(storageKeys.conversation)
  }, [messages])

  async function bootstrap() {
    setStatus('Checking local backend…')
    try {
      await requestJson<{ status: string }>('/health')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to reach the local backend.'
      setStatus(message)
      return
    }

    const [modelsResult, knowledgeResult, voicesResult] = await Promise.allSettled([
      requestJson<{ models: ModelInfo[] }>('/api/models'),
      requestJson<{ documents: KnowledgeDocument[] }>('/api/knowledge'),
      requestJson<VoicesResponse>('/api/voices'),
    ])

    let summary = 'Ready for chat, transcription, and speech roundtrips.'

    if (modelsResult.status === 'fulfilled') {
      setModels(modelsResult.value.models)
      setSelectedModel((current) => {
        if (modelsResult.value.models.some((model) => model.name === current)) {
          return current
        }

        return modelsResult.value.models[0]?.name || ''
      })
      if (modelsResult.value.models.length === 0) {
        summary = 'Connected to Ollama, but no local models were returned.'
      }
    } else {
      setModels([])
      summary = `Model loading failed: ${modelsResult.reason instanceof Error ? modelsResult.reason.message : 'unknown error'}`
    }

    if (knowledgeResult.status === 'fulfilled') {
      setDocuments(knowledgeResult.value.documents)
    } else if (modelsResult.status === 'fulfilled') {
      summary = `Models loaded, but knowledge loading failed: ${knowledgeResult.reason instanceof Error ? knowledgeResult.reason.message : 'unknown error'}`
    }

    if (voicesResult.status === 'fulfilled') {
      setVoices(voicesResult.value.voices)
      setVoice((current) => {
        if (voicesResult.value.voices.includes(current)) {
          return current
        }

        if (voicesResult.value.voices.includes(voicesResult.value.default_voice)) {
          return voicesResult.value.default_voice
        }

        return voicesResult.value.voices[0] ?? current
      })
      setVoiceLang((current) => current || voicesResult.value.default_lang)
    } else if (summary === 'Ready for chat, transcription, and speech roundtrips.') {
      summary = `Voice loading failed: ${voicesResult.reason instanceof Error ? voicesResult.reason.message : 'unknown error'}`
    }

    setStatus(summary)
  }

  async function refreshKnowledge() {
    const payload = await requestJson<{ documents: KnowledgeDocument[] }>('/api/knowledge')
    setDocuments(payload.documents)
  }

  function getConversationHistory() {
    return messages
      .filter((message) => !message.localOnly)
      .map((message) => ({ role: message.role, content: message.content }))
  }

  function startNewChat() {
    if (recording || busy) {
      return
    }

    setMessages([createWelcomeMessage()])
    setDraft('')
    setStatus('Started a new chat.')
  }

  function exportConversation() {
    const conversation = messages.filter((message) => !message.localOnly)
    if (conversation.length === 0) {
      setStatus('There is no conversation to export yet.')
      return
    }

    const archive: ConversationArchive = {
      version: 1,
      exported_at: new Date().toISOString(),
      messages: conversation,
      settings: {
        selectedModel,
        voice,
        voiceLang,
        systemPrompt,
      },
    }

    const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    const timestamp = archive.exported_at.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
    anchor.href = url
    anchor.download = `local-voice-studio-chat-${timestamp}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    setStatus('Conversation exported.')
  }

  async function importConversation(file: File) {
    try {
      const rawText = await file.text()
      const parsed = JSON.parse(rawText) as unknown

      const archive: Partial<ConversationArchive> | null = Array.isArray(parsed)
        ? { messages: parsed }
        : parsed && typeof parsed === 'object'
          ? (parsed as Partial<ConversationArchive>)
          : null

      const importedMessages = Array.isArray(archive?.messages)
        ? archive.messages.map(sanitizeMessage).filter((message): message is ChatMessage => message !== null)
        : []

      if (importedMessages.length === 0) {
        throw new Error('The selected file does not contain any valid chat messages.')
      }

      setMessages(importedMessages)
      const importedSettings = archive?.settings

      if (importedSettings?.systemPrompt && importedSettings.systemPrompt.trim()) {
        setSystemPrompt(importedSettings.systemPrompt)
      }
      if (importedSettings?.selectedModel && importedSettings.selectedModel.trim()) {
        setSelectedModel(importedSettings.selectedModel)
      }
      if (importedSettings?.voice && importedSettings.voice.trim()) {
        setVoice(importedSettings.voice)
      }
      if (importedSettings?.voiceLang && importedSettings.voiceLang.trim()) {
        setVoiceLang(importedSettings.voiceLang)
      }

      setDraft('')
      setStatus(`Imported ${importedMessages.length} messages from ${file.name}.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Conversation import failed.'
      setStatus(message)
    }
  }

  async function sendChatMessage(messageText: string) {
    const trimmed = messageText.trim()
    if (!trimmed || busy) {
      return
    }

    const nextUserMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
    }
    setMessages((current) => [...current, nextUserMessage])
    setDraft('')
    setBusy(true)
    setStatus('Generating a response from Ollama…')

    try {
      const payload = await requestJson<{ reply: string; sources: SourceHit[] }>('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          model: selectedModel,
          system_prompt: systemPrompt,
          use_knowledge: useKnowledge,
          history: getConversationHistory(),
        }),
      })

      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: payload.reply,
          sources: payload.sources,
        },
      ])
      setStatus('Reply ready.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Chat request failed.'
      setStatus(message)
    } finally {
      setBusy(false)
    }
  }

  async function uploadKnowledgeFile(file: File) {
    setUploading(true)
    setStatus(`Indexing ${file.name} into the local vector store…`)

    try {
      const formData = new FormData()
      formData.append('file', file)
      await requestJson('/api/knowledge', {
        method: 'POST',
        body: formData,
      })
      await refreshKnowledge()
      setStatus(`${file.name} indexed successfully.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Knowledge upload failed.'
      setStatus(message)
    } finally {
      setUploading(false)
    }
  }

  async function deleteKnowledge(sourceName: string) {
    await requestJson(`/api/knowledge/${encodeURIComponent(sourceName)}`, {
      method: 'DELETE',
    })
    await refreshKnowledge()
    setStatus(`Removed ${sourceName} from local knowledge.`)
  }

  function cleanupAudioMonitoring() {
    if (monitoringFrameRef.current !== null) {
      cancelAnimationFrame(monitoringFrameRef.current)
      monitoringFrameRef.current = null
    }

    sourceNodeRef.current?.disconnect()
    analyserRef.current?.disconnect()
    sourceNodeRef.current = null
    analyserRef.current = null

    if (audioContextRef.current) {
      void audioContextRef.current.close()
      audioContextRef.current = null
    }

    silenceSinceRef.current = null
    speechDetectedRef.current = false
  }

  function cleanupRecorder() {
    recorderRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    chunksRef.current = []
    cleanupAudioMonitoring()
    recordingModeRef.current = null
    setRecording(false)
    setRecordingMode(null)
  }

  async function playAudioBlob(blob: Blob) {
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    playbackAudioRef.current = audio

    await new Promise<void>((resolve, reject) => {
      audio.onended = () => {
        URL.revokeObjectURL(url)
        if (playbackAudioRef.current === audio) {
          playbackAudioRef.current = null
        }
        resolve()
      }
      audio.onerror = () => {
        URL.revokeObjectURL(url)
        if (playbackAudioRef.current === audio) {
          playbackAudioRef.current = null
        }
        reject(new Error('Audio playback failed.'))
      }

      void audio.play().catch((error: unknown) => {
        URL.revokeObjectURL(url)
        if (playbackAudioRef.current === audio) {
          playbackAudioRef.current = null
        }
        reject(error instanceof Error ? error : new Error('Audio playback failed.'))
      })
    })
  }

  async function speakText(text: string) {
    setStatus('Synthesizing speech…')
    try {
      const response = await fetch(`${apiBaseUrl}/api/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          voice,
          speed: speechSpeed,
          lang: voiceLang,
        }),
      })

      if (!response.ok) {
        throw new Error(`TTS failed with ${response.status}`)
      }

      const blob = await response.blob()
      await playAudioBlob(blob)
      setStatus('Speech playback finished.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Speech synthesis failed.'
      setStatus(message)
    }
  }

  async function transcribeRecording(blob: Blob) {
    setBusy(true)
    setStatus('Transcribing your recording…')
    try {
      const formData = new FormData()
      formData.append('file', blob, 'recording.webm')
      const payload = await requestJson<{ transcript: string }>('/api/stt', {
        method: 'POST',
        body: formData,
      })
      setDraft(payload.transcript)
      setStatus('Transcript inserted into the prompt box.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Transcription failed.'
      setStatus(message)
    } finally {
      setBusy(false)
    }
  }

  async function runSpeechRoundtrip(blob: Blob) {
    setBusy(true)
    setStatus('Running speech-to-speech through Whisper, Ollama, and Kokoro…')
    try {
      const formData = new FormData()
      formData.append('file', blob, 'speech-turn.webm')
      formData.append('model', selectedModel)
      formData.append('system_prompt', systemPrompt)
      formData.append('use_knowledge', String(useKnowledge))
      formData.append('voice', voice)
      formData.append('voice_lang', voiceLang)
      formData.append('speech_speed', String(speechSpeed))
      formData.append('history_json', JSON.stringify(getConversationHistory()))

      const payload = await requestJson<{
        transcript: string
        reply: string
        audio_base64: string
        mime_type: string
        sources: SourceHit[]
      }>('/api/speech-to-speech', {
        method: 'POST',
        body: formData,
      })

      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: 'user', content: payload.transcript },
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: payload.reply,
          sources: payload.sources,
        },
      ])

      const binary = Uint8Array.from(atob(payload.audio_base64), (char) => char.charCodeAt(0))
      await playAudioBlob(new Blob([binary], { type: payload.mime_type }))
      setStatus('Speech roundtrip complete.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Speech roundtrip failed.'
      setStatus(message)
    } finally {
      setBusy(false)
    }
  }

  function stopHandsFreeSession() {
    handsFreeActiveRef.current = false
    setHandsFreeActive(false)

    if (recordingModeRef.current === 'handsfree' && recorderRef.current) {
      setStatus('Stopping hands-free chat…')
      recorderRef.current.stop()
      return
    }

    if (playbackAudioRef.current) {
      playbackAudioRef.current.pause()
      playbackAudioRef.current = null
    }

    setStatus('Hands-free chat stopped.')
  }

  function monitorHandsFreeSilence() {
    const analyser = analyserRef.current
    if (!analyser || !recorderRef.current || recordingModeRef.current !== 'handsfree') {
      return
    }

    const waveform = new Uint8Array(analyser.fftSize)
    analyser.getByteTimeDomainData(waveform)
    const rms = Math.sqrt(
      waveform.reduce((sum, value) => {
        const normalized = (value - 128) / 128
        return sum + normalized * normalized
      }, 0) / waveform.length,
    )
    const now = performance.now()
    const speechThreshold = 0.012
    const silenceThresholdMs = 900

    if (rms > speechThreshold) {
      if (!speechDetectedRef.current) {
        setStatus('Speech detected. Pause when you are done and I will respond.')
      }
      speechDetectedRef.current = true
      silenceSinceRef.current = null
    } else if (speechDetectedRef.current) {
      if (silenceSinceRef.current === null) {
        silenceSinceRef.current = now
      }

      if (now - silenceSinceRef.current >= silenceThresholdMs) {
        recorderRef.current.stop()
        return
      }
    }

    monitoringFrameRef.current = requestAnimationFrame(() => {
      monitorHandsFreeSilence()
    })
  }

  async function setupHandsFreeMonitoring(stream: MediaStream) {
    cleanupAudioMonitoring()
    const audioContext = new AudioContext()
    if (audioContext.state === 'suspended') {
      await audioContext.resume()
    }
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.15
    const sourceNode = audioContext.createMediaStreamSource(stream)
    sourceNode.connect(analyser)

    audioContextRef.current = audioContext
    analyserRef.current = analyser
    sourceNodeRef.current = sourceNode
    silenceSinceRef.current = null
    speechDetectedRef.current = false

    monitoringFrameRef.current = requestAnimationFrame(() => {
      monitorHandsFreeSilence()
    })
  }

  async function startHandsFreeSession() {
    if (handsFreeActive || recording || busy) {
      return
    }

    handsFreeActiveRef.current = true
    setHandsFreeActive(true)
    await startRecording('handsfree')
  }

  async function startRecording(mode: RecorderMode) {
    if (recording || busy) {
      return
    }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (error) {
      if (mode === 'handsfree') {
        handsFreeActiveRef.current = false
        setHandsFreeActive(false)
      }
      const message = error instanceof Error ? error.message : 'Microphone access failed.'
      setStatus(message)
      return
    }

    const recorder = new MediaRecorder(stream)
    chunksRef.current = []
    streamRef.current = stream
    recorderRef.current = recorder
    recordingModeRef.current = mode
    setRecording(true)
    setRecordingMode(mode)
    setStatus(
      mode === 'transcribe'
        ? 'Recording for transcription…'
        : mode === 'handsfree'
          ? 'Hands-free chat is listening… start speaking whenever you are ready.'
          : 'Recording for voice roundtrip…',
    )

    if (mode === 'handsfree') {
      await setupHandsFreeMonitoring(stream)
    }

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunksRef.current.push(event.data)
      }
    }

    recorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
      const continueHandsFree = mode === 'handsfree' && handsFreeActiveRef.current
      cleanupRecorder()
      if (mode === 'transcribe') {
        await transcribeRecording(blob)
      } else {
        await runSpeechRoundtrip(blob)
      }

      if (continueHandsFree && handsFreeActiveRef.current) {
        setStatus('Listening for your next turn…')
        await startRecording('handsfree')
      }
    }

    recorder.start(mode === 'handsfree' ? 250 : undefined)
  }

  function stopRecording() {
    recorderRef.current?.stop()
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Windows speech-to-speech workstation</p>
          <h1>Local Voice Studio</h1>
          <p className="hero-copy">
            Electron desktop shell, Ollama chat, Whisper transcription, Kokoro speech, and a
            built-in local vector store for retrieval.
          </p>
        </div>
        <div className="status-card">
          <span className="status-label">Status</span>
          <strong>{status}</strong>
          <span className="status-meta">API: {apiBaseUrl}</span>
        </div>
      </section>

      <section className="workspace-grid">
        <aside className="panel controls-panel">
          <div className="panel-header">
            <h2>Session Controls</h2>
            <span>{window.assistantRuntime?.platform ?? 'browser'} runtime</span>
          </div>

          <label className="field">
            <span>Model</span>
            <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)}>
              {models.length === 0 ? <option value="">No local models found</option> : null}
              {models.map((model) => (
                <option key={model.name} value={model.name}>
                  {model.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>System prompt</span>
            <textarea
              rows={5}
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
            />
          </label>

          <div className="field two-up">
            <label>
              <span>Voice</span>
              <select value={voice} onChange={(event) => setVoice(event.target.value)}>
                {voices.length === 0 ? <option value={voice || ''}>No voices loaded</option> : null}
                {voices.map((voiceOption) => (
                  <option key={voiceOption} value={voiceOption}>
                    {voiceOption}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Voice language</span>
              <input value={voiceLang} onChange={(event) => setVoiceLang(event.target.value)} />
            </label>
          </div>

          <label className="field">
            <span>Speech speed</span>
            <input
              type="range"
              min="0.7"
              max="1.5"
              step="0.05"
              value={speechSpeed}
              onChange={(event) => setSpeechSpeed(Number(event.target.value))}
            />
            <small>{speechSpeed.toFixed(2)}x</small>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={useKnowledge}
              onChange={(event) => setUseKnowledge(event.target.checked)}
            />
            <span>Use local knowledge retrieval for chat and speech</span>
          </label>

          <div className="button-row">
            <button type="button" onClick={() => void bootstrap()} disabled={busy || uploading}>
              Refresh models
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => void speakText('Local Voice Studio is online.')}
              disabled={busy}
            >
              Test TTS
            </button>
          </div>
        </aside>

        <section className="panel conversation-panel">
          <div className="panel-header">
            <h2>Conversation</h2>
            <div className="panel-actions">
              <span>{getConversationHistory().length} messages</span>
              <button type="button" className="ghost" onClick={startNewChat} disabled={busy || recording}>
                New chat
              </button>
              <button type="button" className="ghost" onClick={exportConversation} disabled={busy}>
                Export
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => importInputRef.current?.click()}
                disabled={busy || recording}
              >
                Import
              </button>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json,.json"
                className="visually-hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) {
                    void importConversation(file)
                  }
                  event.target.value = ''
                }}
              />
            </div>
          </div>

          <div className="messages">
            {messages.map((message) => (
              <article key={message.id} className={`message-bubble ${message.role}`}>
                <header>
                  <strong>{message.role === 'assistant' ? 'Assistant' : 'You'}</strong>
                  {message.role === 'assistant' ? (
                    <button type="button" className="ghost" onClick={() => void speakText(message.content)}>
                      Speak
                    </button>
                  ) : null}
                </header>
                <p>{message.content}</p>
                {message.sources && message.sources.length > 0 ? (
                  <div className="sources">
                    {message.sources.map((source) => (
                      <div key={`${message.id}-${source.source_name}`} className="source-chip">
                        <strong>{source.source_name}</strong>
                        <span>{source.content}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </article>
            ))}
          </div>

          <div className="composer">
            <textarea
              rows={4}
              placeholder="Type a request, paste a transcript, or use the recording buttons below."
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="button-row compact">
              <button type="button" onClick={() => void sendChatMessage(draft)} disabled={busy || !draft.trim()}>
                Send text
              </button>
              <button
                type="button"
                className={recording && recordingMode === 'transcribe' ? 'danger' : 'secondary'}
                onClick={() => (recording ? stopRecording() : void startRecording('transcribe'))}
                disabled={busy || (recording && recordingMode !== 'transcribe')}
              >
                {recording && recordingMode === 'transcribe' ? 'Stop transcript' : 'Record to text'}
              </button>
              <button
                type="button"
                className={recording && recordingMode === 'roundtrip' ? 'danger' : 'secondary'}
                onClick={() => (recording ? stopRecording() : void startRecording('roundtrip'))}
                disabled={busy || (recording && recordingMode !== 'roundtrip')}
              >
                {recording && recordingMode === 'roundtrip' ? 'Stop roundtrip' : 'Voice roundtrip'}
              </button>
              <button
                type="button"
                className={handsFreeActive ? 'danger' : 'secondary'}
                onClick={() => (handsFreeActive ? stopHandsFreeSession() : void startHandsFreeSession())}
                disabled={busy && !handsFreeActive}
              >
                {handsFreeActive ? 'Stop hands-free' : 'Hands-free chat'}
              </button>
            </div>
            <p className="composer-hint">
              `Voice roundtrip` stays push-to-talk. `Hands-free chat` listens for speech, waits for a natural pause, then sends the turn automatically.
            </p>
          </div>
        </section>

        <aside className="panel knowledge-panel">
          <div className="panel-header">
            <h2>Local Knowledge</h2>
            <span>{documents.length} files indexed</span>
          </div>

          <label className="upload-dropzone">
            <input
              type="file"
              accept=".txt,.md,.pdf,.py,.json,.csv"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) {
                  void uploadKnowledgeFile(file)
                }
                event.target.value = ''
              }}
              disabled={uploading}
            />
            <strong>{uploading ? 'Indexing file…' : 'Drop in reference files'}</strong>
            <span>Supported: .txt, .md, .pdf, .py, .json, .csv</span>
          </label>

          <div className="knowledge-list">
            {documents.length === 0 ? <p className="empty-state">No documents indexed yet.</p> : null}
            {documents.map((document) => (
              <article key={document.source_name} className="knowledge-item">
                <div>
                  <strong>{document.source_name}</strong>
                  <span>{document.chunk_count} chunks</span>
                </div>
                <button type="button" className="ghost" onClick={() => void deleteKnowledge(document.source_name)}>
                  Remove
                </button>
              </article>
            ))}
          </div>
        </aside>
      </section>
    </main>
  )
}

export default App

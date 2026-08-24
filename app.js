const isVoiceManager = true;

const VOICE_CONFIG = {
  // Xiaozhi server listens on 8000 in the supplied ZIP.
  // Change only the host if the server runs on another machine.
  xiaozhiWsUrl: "ws://192.168.1.186:8000/xiaozhi/v1/",

  sampleRate: 24000,
  channels: 1,
  frameSamples: 1440,       // 60 ms @ 24 kHz
  bitrate: 24000,

  // This is what enables Xiaozhi's server-side VAD/interrupt path.
  listenMode: "auto"
};

const VoiceState = Object.freeze({
  IDLE: "IDLE",
  CONNECTING: "CONNECTING",
  LISTENING: "LISTENING",
  SPEAKING: "SPEAKING",
  INTERRUPTED: "INTERRUPTED",
  ERROR: "ERROR"
});

const voiceManager = {
  socket: null,
  sessionId: null,

  mediaStream: null,
  audioContext: null,
  sourceNode: null,
  processorNode: null,
  encoder: null,

  decoder: null,
  decoderTimestampUs: 0,
  playbackContext: null,
  nextPlayTime: 0,

  pcmBuffer: new Float32Array(0),
  timestampUs: 0,
  audioRunning: false,
  state: VoiceState.IDLE,

  setState(next) {
    this.state = next;
    console.log("[MIMI VoiceManager]", next);

    const map = {
      IDLE: "IDLE",
      CONNECTING: "CONNECTING",
      LISTENING: "LISTENING",
      SPEAKING: "SPEAKING",
      INTERRUPTED: "INTERRUPTED",
      ERROR: "ERROR"
    };

    setVoicePanel("server", map[next] || next,
      next === VoiceState.ERROR ? "error" :
      next === VoiceState.LISTENING || next === VoiceState.SPEAKING ? "on" : "");
  },

  activity(text) {
    addActivity(text);
  },

  makeWsUrl() {
    const id = () =>
      crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const url = new URL(VOICE_CONFIG.xiaozhiWsUrl);
    url.searchParams.set("device-id", `mimi-web-${id()}`);
    url.searchParams.set("client-id", `mimi-web-client-${id()}`);
    return url.toString();
  },

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;

    this.setState(VoiceState.CONNECTING);
    setVoicePanel("server", "CONNECTING…", "warn");
    addVoiceEvent("WebSocket → CONNECTING");

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.makeWsUrl());
      ws.binaryType = "arraybuffer";
      this.socket = ws;

      const timeout = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error("Xiaozhi WebSocket timeout"));
      }, 10000);

      ws.onopen = () => {
        this.activity("Xiaozhi WS mở");
        addVoiceEvent("Xiaozhi WebSocket OPEN");
        setVoicePanel("websocket", "OPEN", "on");
        setVoicePanel("server", "WebSocket đã mở", "on");

        // aec:true is important: the supplied Xiaozhi server uses
        // server-side AEC + VAD to interrupt TTS when the user speaks.
        ws.send(JSON.stringify({
          type: "hello",
          version: 1,
          features: {
            mcp: true,
            aec: true
          },
          transport: "websocket",
          audio_params: {
            format: "opus",
            sample_rate: 24000,
            channels: 1,
            frame_duration: 60
          }
        }));
      };

      ws.onmessage = async (event) => {
        if (typeof event.data !== "string") {
          await this.handleTtsOpus(event.data);
          return;
        }

        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          this.activity("Xiaozhi → text non-JSON");
          return;
        }

        console.log("[Xiaozhi]", msg);

        if (msg.type === "hello") {
          clearTimeout(timeout);
          this.sessionId = msg.session_id || null;
          this.activity("Xiaozhi hello OK");
          addVoiceEvent("HELLO OK → session nhận");
          setVoicePanel("session", this.sessionId || "—", "on");
          setVoicePanel("server", "HELLO OK", "on");
          setVoicePanel("audio", "Opus / " + (msg.audio_params?.sample_rate || VOICE_CONFIG.sampleRate) + " Hz");
          resolve();
          return;
        }

        await this.handleEvent(msg);
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("Không kết nối được Xiaozhi WebSocket"));
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        this.socket = null;
        this.sessionId = null;
        setVoicePanel("websocket", "CLOSED");
        setVoicePanel("session", "—");
        setVoicePanel("server", "WebSocket đóng");
        if (this.state !== VoiceState.ERROR) {
          this.setState(VoiceState.IDLE);
        }
        this.activity("Xiaozhi WS đóng");
      };
    });
  },

  async handleEvent(msg) {
    switch (msg.type) {
      case "stt":
        setVoicePipeline("stt");
        addVoiceEvent(msg.text ? "STT / FunASR → " + msg.text : "STT EVENT");
        setVoicePanel("stt", msg.text ? "OK" : "EVENT", msg.text ? "on" : "warn");
        if (msg.text) {
          showConversation(msg.text);
          addActivity("Bạn: " + msg.text);
          ui.systemMic.textContent = "Đã nghe";
          setVoicePipeline("thinking");
          addVoiceEvent("MIMI / AI CORE → đang xử lý");
        }
        break;

      case "tts":
        if (msg.state === "start") {
          setVoicePipeline("tts");
          addVoiceEvent("TTS → bắt đầu");
        }
        setVoicePanel("tts", msg.state || "EVENT",
          msg.state === "start" ? "on" :
          msg.state === "stop" ? "" : "warn");
        if (msg.state === "start") {
          this.setState(VoiceState.SPEAKING);
          setStatus("🔊 MIMI ĐANG NÓI…", "speaking");
          ui.systemSpeaker.textContent = "Đang nói";
        } else if (msg.state === "sentence_start") {
          if (msg.text) {
            ui.mimiBubble.textContent = msg.text;
            ui.mimiBubble.classList.remove("hidden");
            addActivity("MIMI: " + msg.text);
          }
        } else if (msg.state === "stop") {
          setVoicePipeline("listening");
          addVoiceEvent("TTS STOP → quay lại LISTENING");
          this.setState(VoiceState.LISTENING);
          setStatus("🎤 MIMI ĐANG NGHE…", "listening");
          ui.systemSpeaker.textContent = "Sẵn sàng";
        }
        break;

      case "llm":
        // Xiaozhi's LLM is configured to MIMI Core, so the browser
        // does not call the Core separately.
        break;

      case "error":
        this.activity("❌ Xiaozhi: " + (msg.message || msg.error || "error"));
        break;

      default:
        this.activity("Xiaozhi → " + (msg.type || "event"));
    }
  },

  async initTtsDecoder() {
    if (this.decoder) return;

    if (!("AudioDecoder" in window) || !("EncodedAudioChunk" in window)) {
      throw new Error(
        "Trình duyệt không hỗ trợ WebCodecs AudioDecoder. " +
        "Cần bật/ dùng trình duyệt có AudioDecoder Opus."
      );
    }

    const support = await AudioDecoder.isConfigSupported({
      codec: "opus",
      sampleRate: 24000,
      numberOfChannels: 1
    });

    if (!support.supported) {
      throw new Error("AudioDecoder không hỗ trợ Opus 24 kHz mono");
    }

    this.playbackContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 24000,
      latencyHint: "interactive"
    });

    await this.playbackContext.resume();
    this.nextPlayTime = this.playbackContext.currentTime;

    this.decoder = new AudioDecoder({
      output: (audioData) => {
        try {
          const frames = audioData.numberOfFrames;
          const buffer = this.playbackContext.createBuffer(
            1,
            frames,
            audioData.sampleRate
          );

          const pcm = new Float32Array(frames);
          audioData.copyTo(pcm, {
            planeIndex: 0,
            format: "f32"
          });

          buffer.copyToChannel(pcm, 0);

          const source = this.playbackContext.createBufferSource();
          source.buffer = buffer;
          source.connect(this.playbackContext.destination);

          const startAt = Math.max(
            this.nextPlayTime,
            this.playbackContext.currentTime + 0.01
          );

          source.start(startAt);
          this.nextPlayTime =
            startAt + buffer.duration;

          audioData.close();
        } catch (error) {
          console.error("[MIMI VoiceManager] TTS playback:", error);
          try { audioData.close(); } catch {}
        }
      },

      error: (error) => {
        console.error("[MIMI VoiceManager] TTS decoder:", error);
        this.activity("❌ TTS decoder: " + (error?.message || error));
      }
    });

    this.decoder.configure({
      codec: "opus",
      sampleRate: 24000,
      numberOfChannels: 1
    });
  },

  async handleTtsOpus(arrayBuffer) {
    if (!arrayBuffer || !arrayBuffer.byteLength) return;

    try {
      await this.initTtsDecoder();

      setVoicePipeline("speaking");
      setVoicePanel("tts", "AUDIO", "on");

      const chunk = new EncodedAudioChunk({
        type: "key",
        timestamp: this.decoderTimestampUs,
        data: new Uint8Array(arrayBuffer)
      });

      this.decoderTimestampUs += 60000;
      this.decoder.decode(chunk);
    } catch (error) {
      this.activity("❌ TTS audio: " + error.message);
    }
  },

  stopTtsPlayback() {
    this.nextPlayTime =
      this.playbackContext?.currentTime || 0;

    try { this.decoder?.reset(); } catch {}
  },

  async startEncoder() {
    if (!("AudioEncoder" in window) || !("AudioData" in window)) {
      throw new Error("Trình duyệt không hỗ trợ WebCodecs AudioEncoder");
    }

    const support =
      await AudioEncoder.isConfigSupported({
        codec: "opus",
        sampleRate: 24000,
        numberOfChannels: 1,
        bitrate: VOICE_CONFIG.bitrate
      });

    if (!support.supported) {
      throw new Error("AudioEncoder không hỗ trợ Opus 24 kHz mono");
    }

    this.encoder = new AudioEncoder({
      output: (chunk) => {
        if (
          !this.audioRunning ||
          this.socket?.readyState !== WebSocket.OPEN
        ) return;

        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        this.socket.send(bytes);
        setVoicePanel("encoder", "OPUS → " + bytes.byteLength + " B", "on");
        setVoicePanel("server", "Đang nhận audio", "on");
      },
      error: (error) => {
        console.error("[MIMI VoiceManager] encoder:", error);
        this.activity("❌ Opus encoder: " + (error?.message || error));
        this.setState(VoiceState.ERROR);
      }
    });

    this.encoder.configure({
      codec: "opus",
      sampleRate: 24000,
      numberOfChannels: 1,
      bitrate: VOICE_CONFIG.bitrate,
      opus: { frameDuration: 60000 }
    });
  },

  appendPcm(input) {
    const merged = new Float32Array(
      this.pcmBuffer.length + input.length
    );

    merged.set(this.pcmBuffer);
    merged.set(input, this.pcmBuffer.length);
    this.pcmBuffer = merged;

    while (this.pcmBuffer.length >= 1440) {
      const frame = this.pcmBuffer.slice(0, 1440);
      this.pcmBuffer = this.pcmBuffer.slice(1440);
      this.encodeFrame(frame);
    }
  },

  encodeFrame(frame) {
    if (!this.encoder || this.encoder.state !== "configured") return;

    const data = new AudioData({
      format: "f32",
      sampleRate: 24000,
      numberOfFrames: 1440,
      numberOfChannels: 1,
      timestamp: this.timestampUs,
      data: new Float32Array(frame)
    });

    this.timestampUs += 60000;

    try {
      this.encoder.encode(data);
    } finally {
      data.close();
    }
  },

  async startMicrophone() {
    this.mediaStream =
      await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });

    this.audioContext =
      new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 24000,
        latencyHint: "interactive"
      });

    await this.audioContext.resume();

    this.sourceNode =
      this.audioContext.createMediaStreamSource(
        this.mediaStream
      );

    this.processorNode =
      this.audioContext.createScriptProcessor(4096, 1, 1);

    this.processorNode.onaudioprocess = (event) => {
      if (!this.audioRunning) return;

      this.appendPcm(
        new Float32Array(
          event.inputBuffer.getChannelData(0)
        )
      );
    };

    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(
      this.audioContext.destination
    );

    this.audioRunning = true;
    setVoicePanel("mic", "ON", "on");
    setVoicePanel("audio", "PCM " + this.audioContext.sampleRate + " Hz");
    this.activity("🎤 Mic → PCM → Opus → Xiaozhi");
  },

  sendListenStart() {
    if (
      this.socket?.readyState !== WebSocket.OPEN ||
      !this.sessionId
    ) return;

    this.socket.send(JSON.stringify({
      session_id: this.sessionId,
      type: "listen",
      state: "start",
      mode: "auto"
    }));

    setVoicePanel("listen", "START", "on");
    setVoicePipeline("listening");
    addVoiceEvent("LISTEN START → mic đang gửi audio");
    setVoicePanel("server", "LISTENING 🎤", "on");
    this.activity("Xiaozhi ← listen/start auto");
  },

  async start() {
    if (this.audioRunning) return;

    try {
      await this.connect();
      await this.startEncoder();
      await this.initTtsDecoder();

      this.pcmBuffer = new Float32Array(0);
      this.timestampUs = 0;
      this.decoderTimestampUs = 0;

      this.sendListenStart();
      await this.startMicrophone();

      this.setState(VoiceState.LISTENING);
      setStatus("🎤 MIMI ĐANG NGHE…", "listening");
      ui.systemMic.textContent = "Đang nghe";
      ui.systemSpeaker.textContent = "Sẵn sàng";
    } catch (error) {
      setVoicePanel("server", "ERROR: " + (error?.message || error), "error");
      await this.stop();
      throw error;
    }
  },

  async stop() {
    this.audioRunning = false;
    setVoicePanel("mic", "OFF");
    setVoicePanel("listen", "STOP");

    if (
      this.socket?.readyState === WebSocket.OPEN &&
      this.sessionId
    ) {
      this.socket.send(JSON.stringify({
        session_id: this.sessionId,
        type: "listen",
        state: "stop",
        mode: "auto"
      }));
    }

    try { this.processorNode?.disconnect(); } catch {}
    try { this.sourceNode?.disconnect(); } catch {}

    this.processorNode = null;
    this.sourceNode = null;

    this.mediaStream?.getTracks().forEach(
      track => track.stop()
    );
    this.mediaStream = null;

    try { await this.audioContext?.close(); } catch {}
    this.audioContext = null;

    try { this.encoder?.close(); } catch {}
    this.encoder = null;

    this.pcmBuffer = new Float32Array(0);
    this.stopTtsPlayback();

    this.setState(VoiceState.IDLE);
    setStatus("Minh đang sẵn sàng", "idle");
    ui.systemMic.textContent = "Sẵn sàng";
    ui.systemSpeaker.textContent = "Sẵn sàng";
  },

  async interrupt() {
    // The supplied Xiaozhi server performs the actual abort when
    // server-side AEC + VAD detects voice while TTS is playing.
    // Reset browser-side TTS playback as soon as the server reports stop.
    this.stopTtsPlayback();
    this.setState(VoiceState.INTERRUPTED);
    await this.start();
  }
};

window.MIMIVoiceManager = voiceManager;


const voicePanelState = {
  mic: "OFF",
  websocket: "OFF",
  session: "—",
  audio: "—",
  encoder: "—",
  listen: "—",
  stt: "—",
  tts: "—",
  server: "Chưa kết nối"
};

function initVoiceStatusPanel() {
  if (document.getElementById("mimi-voice-status-panel")) return;

  const panel = document.createElement("div");
  panel.id = "mimi-voice-status-panel";
  panel.innerHTML = `
    <div class="mimi-vsp-title">MIMI VOICE PIPELINE</div>

    <div class="mimi-vsp-pipeline">
      <div class="mimi-vsp-step" data-step="ready">
        <i>●</i><span>READY</span>
      </div>
      <div class="mimi-vsp-arrow">↓</div>

      <div class="mimi-vsp-step" data-step="listening">
        <i>🎤</i><span>LISTENING</span>
      </div>
      <div class="mimi-vsp-arrow">↓</div>

      <div class="mimi-vsp-step" data-step="stt">
        <i>◉</i><span>STT / FunASR</span>
      </div>
      <div class="mimi-vsp-arrow">↓</div>

      <div class="mimi-vsp-step" data-step="thinking">
        <i>🧠</i><span>MIMI / AI CORE</span>
      </div>
      <div class="mimi-vsp-arrow">↓</div>

      <div class="mimi-vsp-step" data-step="tts">
        <i>◉</i><span>TTS</span>
      </div>
      <div class="mimi-vsp-arrow">↓</div>

      <div class="mimi-vsp-step" data-step="speaking">
        <i>🔊</i><span>SPEAKING</span>
      </div>
    </div>

    <div class="mimi-vsp-current">
      <span>TRẠNG THÁI</span>
      <b data-vsp="server">READY</b>
    </div>

    <div class="mimi-vsp-snapshot">
      <div class="mimi-vsp-snapshot-title">VOICE / XIAOZHI STATUS</div>
      <pre data-vsp-snapshot>MIC          OFF
WEBSOCKET    OFF
SESSION      —
AUDIO        —
ENCODER      —
LISTEN       —
STT          —
TTS          —
--------------------
SERVER       READY</pre>
    </div>

    <div class="mimi-vsp-grid">
      <div><span>MIC</span><b data-vsp="mic">OFF</b></div>
      <div><span>WEBSOCKET</span><b data-vsp="websocket">OFF</b></div>
      <div><span>SESSION</span><b data-vsp="session">—</b></div>
      <div><span>AUDIO</span><b data-vsp="audio">—</b></div>
      <div><span>ENCODER</span><b data-vsp="encoder">—</b></div>
      <div><span>LISTEN</span><b data-vsp="listen">—</b></div>
      <div><span>STT</span><b data-vsp="stt">—</b></div>
      <div><span>TTS</span><b data-vsp="tts">—</b></div>
    </div>

    <div class="mimi-vsp-log">
      <div class="mimi-vsp-log-title">LIVE EVENTS</div>
      <div data-vsp-log></div>
    </div>
  `;

  const style = document.createElement("style");
  style.id = "mimi-voice-status-style";
  style.textContent = `
    #mimi-voice-status-panel {
      width: min(92%, 620px);
      margin: 14px auto 0;
      padding: 12px 14px;
      box-sizing: border-box;
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 12px;
      background: rgba(8,12,24,.72);
      color: #dbeafe;
      font: 12px/1.35 Arial, sans-serif;
      text-align: left;
      backdrop-filter: blur(8px);
    }
    #mimi-voice-status-panel .mimi-vsp-title {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .12em;
      opacity: .72;
      margin-bottom: 10px;
    }
    #mimi-voice-status-panel .mimi-vsp-pipeline {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      padding: 5px 0 9px;
    }
    #mimi-voice-status-panel .mimi-vsp-step {
      width: min(100%, 330px);
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 7px 11px;
      border: 1px solid rgba(255,255,255,.08);
      border-radius: 8px;
      background: rgba(255,255,255,.025);
      opacity: .42;
      transition: .15s ease;
    }
    #mimi-voice-status-panel .mimi-vsp-step i {
      width: 20px;
      text-align: center;
      font-style: normal;
    }
    #mimi-voice-status-panel .mimi-vsp-step span {
      font-weight: 700;
      letter-spacing: .04em;
      opacity: .9;
    }
    #mimi-voice-status-panel .mimi-vsp-step.active {
      opacity: 1;
      border-color: rgba(34,197,94,.7);
      background: rgba(34,197,94,.10);
      box-shadow: 0 0 14px rgba(34,197,94,.16);
    }
    #mimi-voice-status-panel .mimi-vsp-step.done {
      opacity: .75;
      border-color: rgba(59,130,246,.35);
    }
    #mimi-voice-status-panel .mimi-vsp-arrow {
      line-height: 13px;
      opacity: .35;
    }
    #mimi-voice-status-panel .mimi-vsp-current {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 10px;
      margin-bottom: 9px;
      border-radius: 8px;
      background: rgba(255,255,255,.045);
    }
    #mimi-voice-status-panel .mimi-vsp-current b {
      color: #22c55e;
      text-shadow: 0 0 8px rgba(34,197,94,.55);
    }
    #mimi-voice-status-panel .mimi-vsp-snapshot {
      margin: 8px 0 10px;
      padding: 10px 12px;
      border: 1px solid rgba(255,255,255,.09);
      border-radius: 9px;
      background: rgba(0,0,0,.18);
    }
    #mimi-voice-status-panel .mimi-vsp-snapshot-title {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .1em;
      opacity: .62;
      margin-bottom: 6px;
    }
    #mimi-voice-status-panel [data-vsp-snapshot] {
      margin: 0;
      white-space: pre;
      font: 11px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace;
      color: #dbeafe;
      overflow-x: auto;
    }
    #mimi-voice-status-panel .mimi-vsp-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px 12px;
    }
    #mimi-voice-status-panel .mimi-vsp-grid > div,
    #mimi-voice-status-panel .mimi-vsp-server {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }
    #mimi-voice-status-panel span {
      opacity: .58;
    }
    #mimi-voice-status-panel b {
      color: #9ca3af;
      font-weight: 700;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #mimi-voice-status-panel b.vsp-on {
      color: #22c55e;
      text-shadow: 0 0 7px rgba(34,197,94,.65);
    }
    #mimi-voice-status-panel b.vsp-warn {
      color: #f59e0b;
    }
    #mimi-voice-status-panel b.vsp-error {
      color: #ef4444;
    }
    #mimi-voice-status-panel .mimi-vsp-log {
      margin-top: 9px;
      padding-top: 8px;
      border-top: 1px solid rgba(255,255,255,.08);
    }
    #mimi-voice-status-panel .mimi-vsp-log-title {
      font-size: 10px;
      letter-spacing: .1em;
      opacity: .55;
      margin-bottom: 4px;
    }
    #mimi-voice-status-panel [data-vsp-log] {
      max-height: 92px;
      overflow: auto;
      font-size: 10px;
      line-height: 1.45;
      opacity: .78;
    }
    #mimi-voice-status-panel .mimi-vsp-log-item {
      padding: 1px 0;
    }
    @media (max-width: 520px) {
      #mimi-voice-status-panel .mimi-vsp-grid {
        grid-template-columns: 1fr;
      }
    }
  `;
  document.head.appendChild(style);

  const host = ui.talk?.closest(".mimi-stage") || ui.stage || ui.talk?.parentElement;
  if (host) host.appendChild(panel);
}

function setVoicePanel(key, value, tone = "") {
  const el = document.querySelector(
    `#mimi-voice-status-panel [data-vsp="${key}"]`
  );
  if (!el) return;

  el.textContent = value;
  el.classList.remove("vsp-on", "vsp-warn", "vsp-error");

  if (tone) el.classList.add(`vsp-${tone}`);
  voicePanelState[key] = value;
  refreshVoiceSnapshot();
}

function refreshVoiceSnapshot() {
  const el = document.querySelector("#mimi-voice-status-panel [data-vsp-snapshot]");
  if (!el) return;

  const s = voicePanelState;
  el.textContent =
`MIC          ${s.mic}
WEBSOCKET    ${s.websocket}
SESSION      ${s.session}
AUDIO        ${s.audio}
ENCODER      ${s.encoder}
LISTEN       ${s.listen}
STT          ${s.stt}
TTS          ${s.tts}
--------------------
SERVER       ${s.server}`;
}

function setVoicePanelState(next = {}) {
  for (const [key, value] of Object.entries(next)) {
    setVoicePanel(key, value);
  }
}

function setVoicePipeline(step) {
  const order = ["ready", "listening", "stt", "thinking", "tts", "speaking"];
  const index = order.indexOf(step);

  document.querySelectorAll("#mimi-voice-status-panel .mimi-vsp-step")
    .forEach(el => {
      const name = el.dataset.step;
      const i = order.indexOf(name);
      el.classList.toggle("active", name === step);
      el.classList.toggle("done", index >= 0 && i >= 0 && i < index);
    });

  const labels = {
    ready: "READY",
    listening: "LISTENING 🎤",
    stt: "STT / FunASR",
    thinking: "MIMI / AI CORE 🧠",
    tts: "TTS",
    speaking: "SPEAKING 🔊"
  };

  setVoicePanel("server", labels[step] || step,
    step === "speaking" || step === "listening" ? "on" : "");
}

function addVoiceEvent(text) {
  const box = document.querySelector("#mimi-voice-status-panel [data-vsp-log]");
  if (!box) return;

  const item = document.createElement("div");
  item.className = "mimi-vsp-log-item";
  item.textContent = new Date().toLocaleTimeString("vi-VN", {
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  }) + "  " + text;

  box.prepend(item);
  while (box.children.length > 8) box.lastElementChild.remove();
}

function setStatus(text, mode = "idle") {
  ui.status.textContent = text;
  ui.stage.classList.toggle("listening", mode === "listening");
  ui.stage.classList.toggle("speaking", mode === "speaking");
  ui.talk.classList.toggle("listening", mode === "listening");
  ui.talk.querySelector(".mic-icon").textContent =
    mode === "listening" ? "⏹" : "🎙";
}

function addActivity(text, type = "normal") {
  const item = document.createElement("div");
  item.className = "activity-item";
  const time = new Date().toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit"
  });
  item.textContent = `${time}  ${text}`;
  ui.activity.prepend(item);

  while (ui.activity.children.length > 5) {
    ui.activity.lastElementChild.remove();
  }
}

function showConversation(userText, mimiText = "") {
  if (userText) {
    ui.userBubble.textContent = userText;
    ui.userBubble.classList.remove("hidden");
  }

  if (mimiText) {
    ui.mimiBubble.textContent = mimiText;
    ui.mimiBubble.classList.remove("hidden");
  }
}

function setCoreState(online) {
  ui.coreConnection.textContent =
    online ? "Đã kết nối" : "Mất kết nối";
  ui.coreConnection.style.color =
    online ? "var(--green)" : "var(--danger)";
  ui.aiCoreStatus.textContent =
    online ? "Online ●" : "Offline ●";
  ui.aiCoreStatus.style.color =
    online ? "var(--green)" : "var(--danger)";
  ui.systemCore.textContent =
    online ? "Online" : "Offline";
  ui.systemCore.style.color =
    online ? "var(--green)" : "var(--danger)";
}

function updateClock() {
  const now = new Date();
  const value = now.toLocaleTimeString("vi-VN");
  ui.clock.textContent = value;
  ui.statusClock.textContent = value;
}
updateClock();
setInterval(updateClock, 1000);
initVoiceStatusPanel();
setVoicePanel("server", "READY", "on");
setVoicePipeline("ready");
addVoiceEvent("MIMI Voice UI READY");

async function checkCore() {
  // Core is reached by Xiaozhi server, not directly by the browser
  // voice path. This only checks the public health endpoint.
  try {
    const response = await fetch(
      "https://mimi-pro-core.tindhdt7.workers.dev/",
      { cache: "no-store" }
    );
    setCoreState(response.ok);
  } catch {
    setCoreState(false);
  }
}

async function startTalk() {
  try {
    if (voiceManager.audioRunning) {
      await voiceManager.stop();
      return;
    }

    ui.talk.disabled = true;
    await voiceManager.start();
  } catch (error) {
    console.error("[MIMI Voice]", error);
    voiceManager.setState(VoiceState.ERROR);
    setStatus("❌ VOICE ERROR", "idle");
    ui.systemMic.textContent = "Lỗi";
    addActivity("❌ Voice: " + error.message);
  } finally {
    ui.talk.disabled = false;
  }
}

ui.talk.addEventListener("click", startTalk);
ui.quickTalk.addEventListener("click", startTalk);
ui.chatTalk?.addEventListener("click", startTalk);

function activatePage(page) {
  document.querySelectorAll(".nav-item").forEach(button => {
    button.classList.toggle("active", button.dataset.page === page);
  });

  document.querySelectorAll("[data-page-content]").forEach(section => {
    section.classList.toggle("active", section.dataset.pageContent === page);
  });

  closeMobileMenu();
}

document.querySelectorAll(".nav-item").forEach(button => {
  button.addEventListener("click", () => activatePage(button.dataset.page));
});

document.querySelectorAll("[data-action]").forEach(button => {
  button.addEventListener("click", () => activatePage(button.dataset.action));
});

function closeMobileMenu() {
  ui.sidebar.classList.remove("open");
  ui.overlay.style.display = "none";
}

$("mobileMenu").addEventListener("click", () => {
  ui.sidebar.classList.toggle("open");
  ui.overlay.style.display = ui.sidebar.classList.contains("open") ? "block" : "none";
});

ui.overlay.addEventListener("click", closeMobileMenu);

// Battery: use real browser battery API when available; otherwise show a neutral value.
if ("getBattery" in navigator) {
  navigator.getBattery().then(battery => {
    const updateBattery = () => {
      const pct = Math.round(battery.level * 100);
      ui.batteryText.textContent = `${pct}%`;
      ui.batteryValue.textContent = `${pct}%`;
      ui.batteryBar.style.width = `${pct}%`;
      ui.batteryLevel.style.width = `${pct}%`;
      ui.chargeStatus.textContent = battery.charging ? "Đang sạc" : "Đang xả";
    };
    updateBattery();
    battery.addEventListener("levelchange", updateBattery);
    battery.addEventListener("chargingchange", updateBattery);
  });
} else {
  ui.batteryText.textContent = "—";
  ui.batteryValue.textContent = "—";
}

// Seed a clean activity list.
[
  "MIMI đã sẵn sàng.",
  "Hệ thống khởi động hoàn tất.",
  "AI Core đang chờ lệnh."
].forEach(text => addActivity(text));

checkCore();

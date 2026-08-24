const isVoiceManager = true;

const VOICE_CONFIG = {
  // Xiaozhi server listens on 8000 in the supplied ZIP.
  // Change only the host if the server runs on another machine.
  xiaozhiWsUrl: "ws://192.168.1.186:8000/xiaozhi/v1/",

  sampleRate: 16000,
  channels: 1,
  frameSamples: 960,       // 60 ms @ 24 kHz
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
            sample_rate: VOICE_CONFIG.sampleRate,
            channels: VOICE_CONFIG.channels,
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
        if (msg.text) {
          showConversation(msg.text);
          addActivity("Bạn: " + msg.text);
          ui.systemMic.textContent = "Đã nghe";
        }
        break;

      case "tts":
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
      sampleRate: VOICE_CONFIG.sampleRate,
      numberOfChannels: VOICE_CONFIG.channels
    });

    if (!support.supported) {
      throw new Error("AudioDecoder không hỗ trợ Opus 24 kHz mono");
    }

    this.playbackContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: VOICE_CONFIG.sampleRate,
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
      sampleRate: VOICE_CONFIG.sampleRate,
      numberOfChannels: VOICE_CONFIG.channels
    });
  },

  async handleTtsOpus(arrayBuffer) {
    if (!arrayBuffer || !arrayBuffer.byteLength) return;

    try {
      await this.initTtsDecoder();

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
        sampleRate: VOICE_CONFIG.sampleRate,
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
      },
      error: (error) => {
        console.error("[MIMI VoiceManager] encoder:", error);
        this.activity("❌ Opus encoder: " + (error?.message || error));
        this.setState(VoiceState.ERROR);
      }
    });

    this.encoder.configure({
      codec: "opus",
      sampleRate: VOICE_CONFIG.sampleRate,
      numberOfChannels: VOICE_CONFIG.channels,
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

    while (this.pcmBuffer.length >= VOICE_CONFIG.frameSamples) {
      const frame = this.pcmBuffer.slice(0, VOICE_CONFIG.frameSamples);
      this.pcmBuffer = this.pcmBuffer.slice(VOICE_CONFIG.frameSamples);
      this.encodeFrame(frame);
    }
  },

  encodeFrame(frame) {
    if (!this.encoder || this.encoder.state !== "configured") return;

    const data = new AudioData({
      format: "f32",
      sampleRate: VOICE_CONFIG.sampleRate,
      numberOfFrames: VOICE_CONFIG.frameSamples,
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
        sampleRate: VOICE_CONFIG.sampleRate,
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
      await this.stop();
      throw error;
    }
  },

  async stop() {
    this.audioRunning = false;

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


function initMicIndicator() {
  if (!ui.talk || document.getElementById("mimi-mic-indicator")) return;

  const indicator = document.createElement("span");
  indicator.id = "mimi-mic-indicator";
  indicator.setAttribute("aria-label", "Trạng thái micro");
  indicator.title = "Micro đang tắt";

  Object.assign(indicator.style, {
    display: "inline-block",
    width: "12px",
    height: "12px",
    minWidth: "12px",
    borderRadius: "3px",
    marginLeft: "10px",
    verticalAlign: "middle",
    background: "#555",
    opacity: "0.85",
    boxShadow: "none",
    transition: "background 160ms ease, box-shadow 160ms ease, opacity 160ms ease"
  });

  ui.talk.insertAdjacentElement("afterend", indicator);
}

function setMicIndicator(active) {
  const indicator = document.getElementById("mimi-mic-indicator");
  if (!indicator) return;

  indicator.style.background = active ? "#22c55e" : "#555";
  indicator.style.boxShadow = active
    ? "0 0 8px rgba(34,197,94,.9)"
    : "none";
  indicator.style.opacity = active ? "1" : "0.75";
  indicator.title = active ? "Micro đang bật" : "Micro đang tắt";
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
initMicIndicator();
setMicIndicator(false);

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
      setMicIndicator(false);
      return;
    }

    ui.talk.disabled = true;
    await voiceManager.start();
    setMicIndicator(true);
  } catch (error) {
    console.error("[MIMI Voice]", error);
    voiceManager.setState(VoiceState.ERROR);
    setMicIndicator(false);
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

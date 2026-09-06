const CONFIG = {
  // MIMI PRO WEB: LOCAL AI ONLY — không dùng Cloud AI.
  localCoreUrl: "http://192.168.1.186:3000",
  language: "vi-VN",

  
  // MIMI PRO WEB → local Xiaozhi/Edge TTS bridge.
  // The bridge tested successfully on the laptop at port 8788.
  xiaozhiTtsUrl: "http://127.0.0.1:8788/api/tts",
  xiaozhiTtsLanUrl: "http://192.168.1.186:8788/api/tts",

  // Full-answer TTS: AI trả lời xong mới gửi TOÀN BỘ văn bản 1 lần.
  // Timeout tự tăng theo độ dài câu trả lời, không cắt câu thành nhiều request.
  ttsMinTimeout: 15000,
  ttsMaxTimeout: 180000,

  // Giữ lại tên cấu hình cũ để tương thích với code/UI cũ.
  ttsEarlyChunkChars: 70,

  // MIMI PRO WEB → MIMI AI Core → TTS Bridge.
  // Kept as the secondary/fallback TTS path.
  mimiTtsUrl: "https://mimi-ai-core.tindhdt7.workers.dev/api/tts"
};

const $ = (id) => document.getElementById(id);

// ================================
// MIMI CONVERSATION IDENTITY V1 - ADDITIVE
// ================================
function getPersistentId(key, prefix) {
  try {
    let value = localStorage.getItem(key);
    if (!value) {
      value = `${prefix}-${crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
      localStorage.setItem(key, value);
    }
    return value;
  } catch {
    return `${prefix}-${Date.now()}`;
  }
}

const MIMI_USER_ID = getPersistentId(CONFIG.userIdKey, "mimi-user");
const MIMI_SESSION_ID = getPersistentId(CONFIG.sessionIdKey, "mimi-session");

const ui = {
  talk: $("talkButton"),
  quickTalk: $("quickTalk"),
  chatTalk: $("chatTalk"),
  status: $("mimiStatus"),
  stage: document.querySelector(".mimi-stage"),
  wave: $("voiceWave"),
  userBubble: $("userBubble"),
  mimiBubble: $("mimiBubble"),
  activity: $("activityList"),
  coreConnection: $("coreConnection"),
  aiCoreStatus: $("aiCoreStatus"),
  systemCore: $("systemCore"),
  systemMic: $("systemMic"),
  systemSpeaker: $("systemSpeaker"),
  batteryText: $("batteryText"),
  batteryValue: $("batteryValue"),
  batteryBar: $("batteryBar"),
  batteryLevel: $("batteryLevel"),
  chargeStatus: $("chargeStatus"),
  clock: $("clock"),
  statusClock: $("statusClock"),
  sidebar: $("sidebar"),
  overlay: $("mobileOverlay")
};

// ================================
// MIMI TIMING DEBUG V1 - TEST ONLY
// ================================
const MIMI_TIMING_DEBUG = true;
let mimiTiming = null;
function timingNow(){ return performance.now(); }
function timingStart(text){ if(!MIMI_TIMING_DEBUG)return; mimiTiming={start:timingNow(),userText:String(text||''),coreStart:null,fullText:null,textDisplayed:null,ttsRequest:null,ttsResponse:null,audioFirst:null,audioPlay:null,audioEnd:null}; renderTimingDebug(); }
function timingMark(key){ if(!MIMI_TIMING_DEBUG||!mimiTiming)return; mimiTiming[key]=timingNow(); renderTimingDebug(); }
function timingDelta(a,b='start'){ if(!mimiTiming||mimiTiming[a]==null||mimiTiming[b]==null)return null; return Math.max(0,mimiTiming[a]-mimiTiming[b]); }
function timingSec(ms){ return ms==null?'—':`${(ms/1000).toFixed(2)} s`; }
function renderTimingDebug(){
  if(!MIMI_TIMING_DEBUG)return;
  let box=document.getElementById('mimiTimingDebug');
  if(!box){ box=document.createElement('div'); box.id='mimiTimingDebug'; box.style.cssText='position:fixed;right:12px;bottom:12px;z-index:99999;width:min(330px,calc(100vw - 24px));padding:12px 14px;border:1px solid rgba(255,255,255,.18);border-radius:12px;background:rgba(12,16,24,.94);color:#fff;font:12px/1.55 monospace;box-shadow:0 8px 30px rgba(0,0,0,.35);backdrop-filter:blur(8px)'; document.body.appendChild(box); }
  if(!mimiTiming){box.innerHTML='<b>MIMI TIMING DEBUG</b><br>Chưa có lượt test.';return;}
  const rows=[['AI bắt đầu',timingSec(timingDelta('coreStart'))],['FULL TEXT nhận đủ',timingSec(timingDelta('fullText'))],['Text hiển thị',timingSec(timingDelta('textDisplayed','fullText'))],['Gọi TTS',timingSec(timingDelta('ttsRequest','fullText'))],['TTS phản hồi',timingSec(timingDelta('ttsResponse','ttsRequest'))],['Audio đầu tiên',timingSec(timingDelta('audioFirst','ttsRequest'))],['Bắt đầu nói',timingSec(timingDelta('audioPlay','ttsRequest'))],['FULL TEXT → nói',timingSec(timingDelta('audioPlay','fullText'))]];
  box.innerHTML='<b>MIMI TIMING DEBUG</b><br><span style="opacity:.7">'+mimiTiming.userText.slice(0,70)+'</span><hr style="opacity:.2">'+rows.map(([k,v])=>`<div style="display:flex;justify-content:space-between;gap:10px"><span>${k}</span><b>${v}</b></div>`).join('');
}

let recognition = null;
let isListening = false;
let isProcessing = false;
let voicesReady = false;

// iPhone/Safari đôi khi không tự kết thúc Speech Recognition.
// Watchdog này đảm bảo mic không bị kẹt ở trạng thái "đang nghe".
let recognitionWatchdog = null;
let recognitionSilenceTimer = null;
let recognitionSession = 0;

function clearRecognitionWatchdog() {
  if (recognitionWatchdog) {
    clearTimeout(recognitionWatchdog);
    recognitionWatchdog = null;
  }
}

function clearRecognitionSilenceTimer() {
  if (recognitionSilenceTimer) {
    clearTimeout(recognitionSilenceTimer);
    recognitionSilenceTimer = null;
  }
}

// iPhone/Safari có thể không phát onend đúng lúc.
// Vì vậy MIMI tự kết thúc khi không còn nhận thêm chữ trong ~1.6 giây.
function armRecognitionSilenceTimer() {
  clearRecognitionSilenceTimer();
  const session = recognitionSession;
  recognitionSilenceTimer = setTimeout(() => {
    if (session !== recognitionSession) return;
    if (!isListening || isProcessing) return;

    const text = latestTranscript.trim();
    if (!text) return;

    addActivity("⏹ MIMI tự dừng nghe sau khi bạn nói xong", "normal");
    manualStopRequested = false;
    recognitionSession++;
    try { recognition.stop(); } catch {}

    // Không phụ thuộc vào onend/onresult cuối của Safari.
    setTimeout(() => {
      if (!isProcessing && text) processUserText(text);
    }, 180);
  }, 600);
}

// Nút DỪNG NGHE thật trong index.html.
// Trên iPhone, người dùng nói xong có thể bấm nút này để kết thúc phiên mic.
ui.stopListening = $("stopListeningButton");

function showStopListeningButton(show) {
  if (!ui.stopListening) return;
  ui.stopListening.classList.toggle("visible", Boolean(show && isListening));
}

let latestTranscript = "";
let manualStopRequested = false;
let manualStopTimer = null;

function stopListeningManually() {
  if (!recognition || !isListening) return;

  clearRecognitionWatchdog();
  clearRecognitionSilenceTimer();
  clearTimeout(manualStopTimer);
  manualStopRequested = true;
  recognitionSession++;
  addActivity("⏹ Bạn đã dừng nghe", "normal");

  // Trên iPhone, recognition.stop() đôi khi không trả final result ngay.
  // Giữ lại câu interim để MIMI vẫn có thể xử lý thay vì chỉ tắt mic.
  const pendingText = latestTranscript.trim();
  try {
    recognition.stop();
  } catch (error) {
    console.warn("Recognition stop:", error);
  }

  if (pendingText) {
    manualStopTimer = setTimeout(() => {
      if (manualStopRequested && !isProcessing) {
        manualStopRequested = false;
        processUserText(pendingText);
      }
    }, 250);
  }
}

ui.stopListening?.addEventListener("click", stopListeningManually);

function setStatus(text, mode = "idle") {
  ui.status.textContent = text;
  ui.stage.classList.toggle("listening", mode === "listening");
  ui.stage.classList.toggle("speaking", mode === "speaking");
  ui.talk.classList.toggle("listening", mode === "listening");
  ui.talk.querySelector(".mic-icon").textContent =
    mode === "listening" ? "⏹" : "🎙";
}

function updateClock() {
  const now = new Date();
  const value = now.toLocaleTimeString("vi-VN");
  ui.clock.textContent = value;
  ui.statusClock.textContent = value;
}
updateClock();
setInterval(updateClock, 1000);

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
  ui.userBubble.textContent = userText;
  ui.userBubble.classList.remove("hidden");

  if (mimiText) {
    ui.mimiBubble.textContent = mimiText;
    ui.mimiBubble.classList.remove("hidden");
  }
}

function setCoreState(online) {
  ui.coreConnection.textContent = online ? "Đã kết nối" : "Mất kết nối";
  ui.coreConnection.style.color = online ? "var(--green)" : "var(--danger)";
  ui.aiCoreStatus.textContent = online ? "Online ●" : "Offline ●";
  ui.aiCoreStatus.style.color = online ? "var(--green)" : "var(--danger)";
  ui.systemCore.textContent = online ? "Online" : "Offline";
  ui.systemCore.style.color = online ? "var(--green)" : "var(--danger)";
}

async function checkCore() {
  try {
    const response = await fetch(CONFIG.localCoreUrl + "/", {
      method: "OPTIONS",
      cache: "no-store"
    });
    setCoreState(response.ok || response.status === 204);
  } catch {
    // CORS/OPTIONS may be unavailable even while POST works.
    // Keep the UI optimistic until an actual chat request fails.
    setCoreState(true);
  }
}

async function streamMimi(text, onChunk) {
  const response = await fetch(CONFIG.localCoreUrl + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: text,
      provider: "local",
      stream: true,
      user_id: MIMI_USER_ID,
      session_id: MIMI_SESSION_ID,
      source: "mimi-pro-web",
    }),
    cache: "no-store"
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();

  // Backward compatible fallback: old Core can still return one JSON response.
  if (!response.body || contentType.includes("application/json")) {
    const data = await response.json();
    const answer = data.reply || data.response || data.message || data.text ||
      "MIMI chưa có câu trả lời.";
    onChunk(answer, true);
    return answer;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";

  const emit = (value) => {
    if (!value) return;
    fullText += value;
    onChunk(value, false);
  };

  const parseLine = (rawLine) => {
    let line = rawLine.trim();
    if (!line || line === "data: [DONE]") return;
    if (line.startsWith("data:")) line = line.slice(5).trim();
    if (!line) return;

    try {
      const data = JSON.parse(line);
      const chunk =
        data?.choices?.[0]?.delta?.content ??
        data?.choices?.[0]?.message?.content ??
        data?.token ?? data?.delta ?? data?.content ?? data?.text ??
        data?.response ?? data?.reply ?? "";
      if (chunk) emit(String(chunk));
    } catch {
      // Do not treat incomplete SSE JSON as plain text.
      if (!rawLine.trim().startsWith("data:")) emit(rawLine.trim());
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) parseLine(line);
  }

  buffer += decoder.decode();
  if (buffer.trim()) parseLine(buffer);

  return fullText || "MIMI chưa có câu trả lời.";
}

async function askMimi(text) {
  // Compatibility helper for any older code path.
  let answer = "";
  await streamMimi(text, chunk => { answer += chunk; });
  return answer || "MIMI chưa có câu trả lời.";
}

function getAdaptiveTtsTimeout(text) {
  const length = String(text || "").trim().length;
  const estimated = 15000 + (length * 70);
  return Math.min(
    Number(CONFIG.ttsMaxTimeout || 180000),
    Math.max(Number(CONFIG.ttsMinTimeout || 15000), estimated)
  );
}

function getSpeechVoices() {
  if (!("speechSynthesis" in window)) return [];
  return speechSynthesis.getVoices() || [];
}

function chooseVietnameseVoice() {
  const voices = getSpeechVoices();

  // Ưu tiên tuyệt đối giọng tiếng Việt.
  return (
    voices.find(v => /^vi(-|_)/i.test(String(v.lang || ""))) ||
    voices.find(v => /Vietnamese|Tiếng Việt|Vietnam/i.test(String(v.name || ""))) ||
    null
  );
}

function waitForVietnameseVoice(timeout = 3000) {
  return new Promise(resolve => {
    const first = chooseVietnameseVoice();
    if (first) {
      resolve(first);
      return;
    }

    if (!("speechSynthesis" in window)) {
      resolve(null);
      return;
    }

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      speechSynthesis.removeEventListener("voiceschanged", check);
      resolve(chooseVietnameseVoice());
    };

    const check = () => {
      const voice = chooseVietnameseVoice();
      if (voice) finish();
    };

    const timer = setTimeout(finish, timeout);
    speechSynthesis.addEventListener("voiceschanged", check);
    speechSynthesis.getVoices();
    setTimeout(check, 100);
  });
}


// ================================
// MIMI TTS NORMALIZER V1 - ADDITIVE
// ================================
// Chỉ chuẩn hóa bản text gửi vào TTS.
// UI / AI Core / Memory vẫn giữ nguyên câu trả lời gốc.
function normalizeTextForTTS(text) {
  let value = String(text || "");

  const replacements = [
    [/\bMIMI\b/gi, "Mi Mi"],
    [/\bTTS\b/gi, "chuyển văn bản thành giọng nói"],
    [/\bASR\b/gi, "nhận dạng giọng nói"],
    [/\bVAD\b/gi, "phát hiện giọng nói"],
    [/\bAI\b/gi, "trí tuệ nhân tạo"],
    [/\bAPI\b/gi, "giao diện lập trình ứng dụng"],
    [/\bMCP\b/gi, "giao thức kết nối công cụ"],
    [/\bESP32-S3\b/gi, "bo mạch ESP ba hai S ba"],
    [/\bESP32\b/gi, "bo mạch ESP ba hai"]
  ];

  for (const [pattern, replacement] of replacements) {
    value = value.replace(pattern, replacement);
  }

  return value.replace(/\s+/g, " ").trim();
}

async function speakWithMimiWorkerTts(text) {
  const url = String(CONFIG.mimiTtsUrl || "").trim();
  const value = normalizeTextForTTS(text);

  if (!url || !value) return false;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    getAdaptiveTtsTimeout(value)
  );

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: value,
        language: "vi-VN",
        voice: "vi-VN-NamMinhNeural"
      }),
      cache: "no-store",
      signal: controller.signal
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn("MIMI Worker TTS HTTP:", response.status, detail);
      return false;
    }

    const contentType =
      String(response.headers.get("content-type") || "").toLowerCase();

    if (contentType.includes("audio/")) {
      const blob = await response.blob();
      timingMark("audioFirst");
      return await playTtsAudioBlob(blob);
    }

    if (contentType.includes("application/json")) {
      const data = await response.json();

      if (data.audio_url || data.url) {
        const audioResponse = await fetch(data.audio_url || data.url, {
          cache: "no-store"
        });
        if (!audioResponse.ok) return false;

        const blob = await audioResponse.blob();
        return await playTtsAudioBlob(blob);
      }

      if (data.audio_base64 || data.audio) {
        const base64 = String(data.audio_base64 || data.audio);
        const mime = String(data.mime_type || "audio/mpeg");
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);

        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }

        return await playTtsAudioBlob(new Blob([bytes], { type: mime }));
      }
    }

    console.warn("MIMI Worker TTS không trả về audio:", contentType);
    return false;
  } catch (error) {
    if (error?.name === "AbortError") {
      console.warn("MIMI Worker TTS timeout.");
    } else {
      console.warn("MIMI Worker TTS chưa sẵn sàng:", error);
    }
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function getTtsStreamUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (value.endsWith("/api/tts")) return `${value}/stream-http`;
  return value;
}

async function playTtsStream(response, contentType = "audio/mpeg") {
  if (!response?.body) {
    console.warn("TTS streaming không có response.body");
    return false;
  }

  if (!("MediaSource" in window)) {
    console.warn("Trình duyệt không hỗ trợ MediaSource; bỏ qua local streaming TTS.");
    addActivity("⚠️ Trình duyệt không hỗ trợ TTS streaming");
    return false;
  }

  const mime = String(contentType || "audio/mpeg").split(";")[0].trim() || "audio/mpeg";
  if (!MediaSource.isTypeSupported(mime)) {
    console.warn("MediaSource không hỗ trợ MIME:", mime);
    addActivity(`⚠️ Không hỗ trợ audio streaming: ${mime}`);
    return false;
  }

  const mediaSource = new MediaSource();
  const audioUrl = URL.createObjectURL(mediaSource);
  const audio = new Audio();
  audio.preload = "auto";
  audio.src = audioUrl;

  let sourceBuffer = null;
  let queue = [];
  let streamDone = false;
  let failed = false;
  let playStarted = false;
  let firstChunkMarked = false;
  let resolvePlayback;
  let rejectPlayback;

  const playbackDone = new Promise((resolve, reject) => {
    resolvePlayback = resolve;
    rejectPlayback = reject;
  });

  const fail = (error) => {
    if (failed) return;
    failed = true;
    rejectPlayback(error instanceof Error ? error : new Error(String(error || "TTS stream failed")));
  };

  const appendNext = () => {
    if (failed || !sourceBuffer || sourceBuffer.updating || !queue.length) {
      if (!failed && streamDone && sourceBuffer && !sourceBuffer.updating && !queue.length) {
        try { mediaSource.endOfStream(); } catch {}
      }
      return;
    }

    const chunk = queue.shift();
    try {
      sourceBuffer.appendBuffer(chunk);
    } catch (error) {
      fail(error);
    }
  };

  mediaSource.addEventListener("sourceopen", () => {
    try {
      sourceBuffer = mediaSource.addSourceBuffer(mime);
      sourceBuffer.mode = "sequence";
      sourceBuffer.addEventListener("updateend", () => {
        if (!playStarted && audio.readyState >= 2) {
          playStarted = true;
          timingMark("audioPlay");
          setStatus("🔊 MIMI ĐANG NÓI…", "speaking");
          ui.systemSpeaker.textContent = "Đang nói";
          audio.play().catch(fail);
        }
        appendNext();
      });
      sourceBuffer.addEventListener("error", () => fail(new Error("MediaSource SourceBuffer error")));
      appendNext();
    } catch (error) {
      fail(error);
    }
  }, { once: true });

  audio.addEventListener("playing", () => {
    if (!playStarted) {
      playStarted = true;
      timingMark("audioPlay");
    }
    setStatus("🔊 MIMI ĐANG NÓI…", "speaking");
    ui.systemSpeaker.textContent = "Đang nói";
  });

  audio.addEventListener("ended", () => {
    timingMark("audioEnd");
    resolvePlayback(true);
  }, { once: true });

  audio.addEventListener("error", () => {
    fail(new Error("Audio playback error"));
  }, { once: true });

  setStatus("🔊 MIMI ĐANG CHUẨN BỊ GIỌNG…", "speaking");
  ui.systemSpeaker.textContent = "Đang chuẩn bị";
  addActivity("🔊 MIMI đang nói bằng Edge TTS tiếng Việt (streaming)");

  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.byteLength) continue;

      if (!firstChunkMarked) {
        firstChunkMarked = true;
        timingMark("audioFirst");
      }

      // Copy the Uint8Array because the reader's buffer may be reused.
      queue.push(new Uint8Array(value).buffer);
      appendNext();

      // Start playback as soon as the first buffered audio is ready.
      if (!playStarted && audio.readyState >= 2) {
        try {
          await audio.play();
        } catch (error) {
          fail(error);
          break;
        }
      }
    }

    streamDone = true;
    appendNext();

    if (!playStarted && !failed) {
      try {
        await audio.play();
      } catch (error) {
        fail(error);
      }
    }

    return await playbackDone;
  } catch (error) {
    fail(error);
    return false;
  } finally {
    try { audio.pause(); } catch {}
    audio.removeAttribute("src");
    try { audio.load(); } catch {}
    URL.revokeObjectURL(audioUrl);
    ui.systemSpeaker.textContent = "Sẵn sàng";
    setStatus("Mình đang sẵn sàng", "idle");
  }
}

async function speakWithXiaozhi(text) {
  // Xiaozhi/Edge TTS vẫn là adapter TTS của MIMI.
  // Chỉ nâng cấp đường nhận audio: /api/tts -> /api/tts/stream-http.
  // Một câu trả lời = một request TTS; audio được phát ngay từ chunk đầu.
  const isLocalHost =
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1" ||
    location.hostname === "::1";

  const baseUrl = String(
    isLocalHost
      ? (CONFIG.xiaozhiTtsUrl || "")
      : (CONFIG.xiaozhiTtsLanUrl || CONFIG.xiaozhiTtsUrl || "")
  ).trim();
  const url = getTtsStreamUrl(baseUrl);
  if (!url) return false;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    getAdaptiveTtsTimeout(text)
  );

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: String(text || ""),
        language: "vi-VN",
        voice: "vi-VN-NamMinhNeural"
      }),
      cache: "no-store",
      signal: controller.signal
    });

    timingMark("ttsResponse");

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn("Xiaozhi TTS HTTP:", response.status, detail);
      return false;
    }

    const contentType =
      String(response.headers.get("content-type") || "audio/mpeg").toLowerCase();

    if (contentType.includes("audio/")) {
      return await playTtsStream(response, contentType);
    }

    // Compatibility: keep accepting a JSON response from the Worker/legacy bridge.
    if (contentType.includes("application/json")) {
      const data = await response.json();
      if (data.audio_url || data.url) {
        const audioResponse = await fetch(data.audio_url || data.url, { cache: "no-store" });
        if (!audioResponse.ok) return false;
        const blob = await audioResponse.blob();
        return await playTtsAudioBlob(blob);
      }
      if (data.audio_base64 || data.audio) {
        const base64 = String(data.audio_base64 || data.audio);
        const mime = String(data.mime_type || "audio/mpeg");
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return await playTtsAudioBlob(new Blob([bytes], { type: mime }));
      }
    }

    console.warn("Xiaozhi TTS không trả về audio:", contentType);
    return false;
  } catch (error) {
    if (error?.name === "AbortError") {
      console.warn("Xiaozhi TTS timeout.");
      addActivity("⚠️ TTS Bridge phản hồi quá lâu");
    } else {
      console.warn("Xiaozhi TTS streaming chưa sẵn sàng:", error);
      addActivity("⚠️ Edge TTS streaming lỗi; sẽ thử lại");
    }
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function playTtsAudioBlob(blob) {
  if (!blob || !blob.size) return false;

  const audioUrl = URL.createObjectURL(blob);
  const audio = new Audio(audioUrl);
  audio.preload = "auto";

  setStatus("🔊 MIMI ĐANG NÓI…", "speaking");
  ui.systemSpeaker.textContent = "Đang nói";
  addActivity("🔊 MIMI đang nói bằng Edge TTS tiếng Việt");

  try {
    await new Promise((resolve, reject) => {
      audio.onended = resolve;
      audio.onerror = () => reject(new Error("Audio playback error"));

      const playPromise = audio.play();
      if (playPromise?.catch) playPromise.catch(reject);
    });

    return true;
  } catch (error) {
    console.warn("Không phát được audio từ TTS Bridge:", error);
    addActivity("⚠️ Không phát được audio từ TTS Bridge");
    return false;
  } finally {
    URL.revokeObjectURL(audioUrl);
    ui.systemSpeaker.textContent = "Sẵn sàng";
    setStatus("Mình đang sẵn sàng", "idle");
  }
}

async function speak(text) {
  if (!("speechSynthesis" in window)) {
    ui.systemSpeaker.textContent = "Không hỗ trợ TTS";
    addActivity("⚠️ Trình duyệt không hỗ trợ đọc văn bản");
    return;
  }

  const value = normalizeTextForTTS(text);
  if (!value) return;

  // iPhone/Safari có thể giữ speechSynthesis ở trạng thái paused.
  speechSynthesis.cancel();
  speechSynthesis.resume();

  const voice = chooseVietnameseVoice() || await waitForVietnameseVoice(500);

  if (!voice) {
    ui.systemSpeaker.textContent = "Thiếu giọng tiếng Việt";
    addActivity("⚠️ Không tìm thấy giọng TTS tiếng Việt trên thiết bị");
    setStatus("⚠️ Chưa có giọng tiếng Việt", "idle");
    return;
  }

  const utterance = new SpeechSynthesisUtterance(value);
  utterance.voice = voice;
  utterance.lang = voice.lang || "vi-VN";
  utterance.rate = 0.95;
  utterance.pitch = 1;
  utterance.volume = 1;

  utterance.onstart = () => {
    timingMark("audioPlay");
    setStatus("🔊 MIMI ĐANG NÓI…", "speaking");
    ui.systemSpeaker.textContent = "Đang nói";
  };

  utterance.onend = () => {
    ui.systemSpeaker.textContent = "Sẵn sàng";
    setStatus("Mình đang sẵn sàng", "idle");
  };

  utterance.onerror = event => {
    console.error("TTS ERROR:", event);
    ui.systemSpeaker.textContent = "TTS lỗi";
    setStatus("❌ Không phát được giọng tiếng Việt", "idle");
  };

  // Gọi resume ngay trước speak để ổn định hơn trên iOS.
  speechSynthesis.resume();
  speechSynthesis.speak(utterance);

  // Một số bản Safari/iOS cần resume thêm một lần sau khi queue.
  setTimeout(() => {
    if (speechSynthesis.speaking) speechSynthesis.resume();
  }, 100);
}

if ("speechSynthesis" in window) {
  speechSynthesis.onvoiceschanged = () => {
    voicesReady = true;
    const voice = chooseVietnameseVoice();
    if (voice) {
      ui.systemSpeaker.textContent = "Sẵn sàng";
      console.log("MIMI Vietnamese TTS:", voice.name, voice.lang);
    }
  };
}

// Chrome/Windows/iPhone Safari tải danh sách TTS bất đồng bộ.

if ("speechSynthesis" in window) {
  speechSynthesis.addEventListener("voiceschanged", () => {
    console.log(
      "MIMI Vietnamese voices:",
      speechSynthesis.getVoices()
        .filter(v => /^vi(-|_)/i.test(String(v.lang || "")))
        .map(v => `${v.name} (${v.lang})`)
    );
  });
}

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.lang = CONFIG.language;
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    manualStopRequested = false;
    latestTranscript = "";
    isListening = true;
    setStatus("🎤 MIMI ĐANG NGHE…", "listening");
    ui.systemMic.textContent = "Đang nghe";
    showStopListeningButton(true);

    // Không cho iPhone giữ microphone vô hạn.
    clearRecognitionWatchdog();
    const session = ++recognitionSession;
    recognitionWatchdog = setTimeout(() => {
      if (session !== recognitionSession) return;
      if (isListening && !isProcessing) {
        addActivity("ℹ️ Mic tự dừng sau thời gian chờ");
        try { recognition.stop(); } catch {}
      }
    }, 12000);
  };

  recognition.onspeechstart = () => {
    setStatus("👂 MIMI ĐANG NGHE GIỌNG…", "listening");

    // Khi đã bắt đầu có tiếng nói, cho thêm thời gian ngắn để nhận câu.
    clearRecognitionWatchdog();
    const session = recognitionSession;
    recognitionWatchdog = setTimeout(() => {
      if (session !== recognitionSession) return;
      if (isListening && !isProcessing) {
        try { recognition.stop(); } catch {}
      }
    }, 10000);
  };

  // Safari/iOS thường phát event này khi người dùng ngừng nói.
  // Chủ động stop để tránh trạng thái "đang nghe" kéo dài.
  recognition.onspeechend = () => {
    clearRecognitionWatchdog();
    // Đừng stop ngay: iOS đôi khi phát onspeechend giữa câu.
    // Cho timer chờ thêm 1.6 giây để lấy phần cuối câu.
    if (isListening && !isProcessing && latestTranscript.trim()) {
      armRecognitionSilenceTimer();
    }
  };


// ================================
// MIMI FAST RESPONSE V1 - ADDITIVE
// ================================
// Very simple conversational intents do not need an LLM.
// This keeps the existing AI/Memory/Provider pipeline untouched.
function getFastResponse(text) {
  const value = String(text || "").trim().toLowerCase()
    .replace(/\s+/g, " ");

  const patterns = [
    [/^(mimi[,.! ]*)?(cậu )?(nghe( mình)?|nghe không|có nghe)([!.?]*)$/i,
      "Dạ, MIMI nghe đây! 😊"],
    [/^(mimi[,.! ]*)?(cậu )?(ở đó|có đó)( không)?[!.?]*$/i,
      "Dạ, MIMI ở đây nè! 😊"],
    [/^(mimi[,.! ]*)?(xin chào|chào mimi|hello)[!.?]*$/i,
      "Dạ, chào cậu! MIMI đây 😊"],
    [/^(mimi[,.! ]*)?(cảm ơn|thank you|thanks)[!.?]*$/i,
      "Dạ, không có gì nha! 😊"],
    [/^(mimi[,.! ]*)?(ok|okay|được rồi|ừ|ừm)[!.?]*$/i,
      "Dạ! 😊"],
  ];

  for (const [pattern, response] of patterns) {
    if (pattern.test(value)) return response;
  }

  return null;
}

  async function processUserText(finalText) {
    const cleanText = (finalText || "").trim();
    if (!cleanText || isProcessing) return;

    isProcessing = true;
    timingStart(cleanText);
    timingMark("coreStart");
    manualStopRequested = false;
    clearTimeout(manualStopTimer);
    ui.talk.disabled = true;
    setStatus("🤖 MIMI ĐANG SUY NGHĨ…", "idle");
    ui.systemMic.textContent = "Đang xử lý";
    showStopListeningButton(false);
    showConversation(cleanText);
    addActivity(`Bạn: ${cleanText}`);

    // Fast path: các câu giao tiếp cực đơn giản không cần đi qua AI Core.
    // Tận dụng getFastResponse() đã có sẵn, giúp "MIMI chào cậu",
    // "cậu có nghe không", "cảm ơn"... phản hồi gần như tức thì.
    const fastResponse = getFastResponse(cleanText);
    if (fastResponse) {
      displayedAnswer = fastResponse;
      timingMark("fullText");
      showConversation(cleanText, displayedAnswer);
      timingMark("textDisplayed");
      addActivity(`MIMI: ${displayedAnswer}`);

      try {
        timingMark("ttsRequest");
        console.log(`🎙️ MIMI FAST TTS: ${displayedAnswer.length} chars`);
        ttsOk = await speakWithXiaozhi(displayedAnswer);

        if (!ttsOk) {
          console.warn("⚠️ Local Edge TTS failed; trying Worker TTS once.");
          ttsOk = await speakWithMimiWorkerTts(displayedAnswer);
        }
      } catch (ttsError) {
        console.warn("Fast-path TTS error:", ttsError);
        ttsOk = await speakWithMimiWorkerTts(displayedAnswer);
      }

      setCoreState(true);
      return;
    }

    // TTS policy V2:
    // - AI vẫn stream nội bộ để nhận câu trả lời nhanh.
    // - Không gửi TTS từng chunk/câu.
    // - Chờ AI Core trả lời hoàn tất, sau đó hiện TOÀN BỘ text một lần.
    // - Gửi TOÀN BỘ câu trả lời sang Xiaozhi/Edge TTS đúng 1 request.
    // - Không dùng Browser SpeechSynthesis làm đường TTS bình thường.
    let displayedAnswer = "";
    let ttsOk = false;

    try {
      // Primary path: luôn đi qua MIMI AI Core để giữ Memory/Context đồng bộ.
      // Callback chỉ GHÉP text, tuyệt đối không gọi TTS trong lúc stream.
      const answer = await streamMimi(cleanText, (chunk) => {
        if (!chunk) return;
        displayedAnswer += chunk;
        setCoreState(true);
      });

      if (!displayedAnswer.trim()) {
        displayedAnswer = answer;
      }

      displayedAnswer = String(displayedAnswer || "MIMI chưa có câu trả lời.").trim();
      timingMark("fullText");

      // Hiện toàn bộ câu trả lời một lần, sau khi AI Core đã hoàn tất.
      showConversation(cleanText, displayedAnswer);
      timingMark("textDisplayed");
      addActivity(`MIMI: ${displayedAnswer}`);

      // Một request TTS duy nhất cho toàn bộ câu trả lời.
      const ttsTimeout = getAdaptiveTtsTimeout(displayedAnswer);
      console.log(
        `🎙️ MIMI FULL TTS: ${displayedAnswer.length} chars, timeout ${ttsTimeout} ms`
      );

      setStatus("🔊 MIMI ĐANG CHUẨN BỊ GIỌNG…", "speaking");
      ui.systemSpeaker.textContent = "Đang chuẩn bị";

      // Local Edge TTS is the primary path. Retry transient LAN/Edge failures
      // before using the cloud Worker fallback. Still only ONE successful audio
      // response is played for the whole answer.
      // TTS server đã có retry nội bộ trước FIRST AUDIO.
      // Không retry thêm ở app để tránh chồng retry và làm câu ngắn bị kéo dài.
      console.log("🎙️ Local Edge TTS request 1/1");
      timingMark("ttsRequest");
      ttsOk = await speakWithXiaozhi(displayedAnswer);

      if (!ttsOk) {
        console.warn("⚠️ Local Edge TTS failed twice; trying Worker TTS once.");
        ttsOk = await speakWithMimiWorkerTts(displayedAnswer);
      }

      if (!ttsOk) {
        // Không gọi Browser TTS vì thiết bị không đảm bảo có giọng tiếng Việt.
        setStatus("⚠️ TTS CHƯA SẴN SÀNG", "idle");
        ui.systemSpeaker.textContent = "TTS lỗi";
        addActivity("⚠️ Edge TTS không trả được audio");
      }
    
    } catch (error) {
      console.error("MIMI CORE ERROR:", error);

      // Emergency fallback only. Normal conversation never bypasses Core.
      const fallback = getFastResponse(cleanText);
      if (fallback) {
        displayedAnswer = fallback;
        showConversation(cleanText, displayedAnswer);
        addActivity(`MIMI OFFLINE FAST: ${displayedAnswer}`);
        showConversation(cleanText, displayedAnswer);
        await speakWithXiaozhi(displayedAnswer) || await speakWithMimiWorkerTts(displayedAnswer);

        setCoreState(false);
        return;
      }

      setCoreState(false);
      setStatus("❌ AI CORE ERROR", "idle");
      showConversation(cleanText, `Mình đang gặp lỗi kết nối với AI Core: ${error.message}`);
      addActivity("MIMI: Lỗi kết nối AI Core");
    } finally {
      isProcessing = false;
      ui.talk.disabled = false;
      ui.systemMic.textContent = "Sẵn sàng";
      latestTranscript = "";
      if (!ui.stage.classList.contains("speaking")) {
        setStatus("Minh đang sẵn sàng", "idle");
      }
    }
  }

  recognition.onresult = async (event) => {
    let finalText = "";
    let interimText = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const chunk = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += chunk;
      else interimText += chunk;
    }

    const text = (finalText || interimText).trim();
    if (!text) return;

    latestTranscript = text;

    // Mỗi lần có thêm chữ thì reset bộ đếm im lặng.
    if (!finalText) armRecognitionSilenceTimer();

    if (!finalText) {
      ui.userBubble.textContent = text;
      ui.userBubble.classList.remove("hidden");
      return;
    }

    await processUserText(finalText);
  };

  recognition.onerror = (event) => {
    clearRecognitionWatchdog();
    clearRecognitionSilenceTimer();
    recognitionSession++;
    isListening = false;
    showStopListeningButton(false);
    ui.talk.disabled = false;
    ui.systemMic.textContent = "Sẵn sàng";

    const error = event.error;
    if (error === "not-allowed" || error === "permission-denied") {
      setStatus("❌ Chưa được cấp quyền microphone", "idle");
    } else if (error === "service-not-allowed") {
      setStatus("❌ Trình duyệt chặn Speech Recognition", "idle");
    } else if (error === "no-speech") {
      setStatus("⚠️ MIMI không nghe thấy giọng nói", "idle");
    } else if (error === "network") {
      setStatus("❌ Speech Recognition lỗi mạng", "idle");
    } else {
      setStatus(`❌ Speech: ${error}`, "idle");
    }
  };

  recognition.onend = () => {
    clearRecognitionWatchdog();
    clearRecognitionSilenceTimer();
    recognitionSession++;
    isListening = false;
    showStopListeningButton(false);

    // Nếu Safari kết thúc phiên nhưng chưa phát final result,
    // vẫn xử lý transcript cuối cùng.
    if (latestTranscript.trim() && !isProcessing && !manualStopRequested) {
      const text = latestTranscript.trim();
      setTimeout(() => {
        if (!isProcessing) processUserText(text);
      }, 80);
      return;
    }

    // Nếu đã có câu và người dùng vừa bấm DỪNG, chờ handler 250 ms xử lý.
    if (manualStopRequested && latestTranscript.trim() && !isProcessing) return;

    manualStopRequested = false;
    if (!isProcessing) {
      ui.talk.disabled = false;
      ui.systemMic.textContent = "Sẵn sàng";
      if (!ui.stage.classList.contains("speaking")) {
        setStatus("Minh đang sẵn sàng", "idle");
      }
    }
  };
} else {
  ui.systemMic.textContent = "Không hỗ trợ";
  setStatus("❌ Trình duyệt không hỗ trợ Speech Recognition", "idle");
}

function startTalk() {
  if (!recognition) return;

  // Không mở phiên nghe mới trong lúc MIMI đang xử lý/trả lời.
  if (isProcessing) return;

  // iPhone/Safari: unlock audio during the user gesture.
  if ("speechSynthesis" in window) {
    speechSynthesis.cancel();
    const unlock = new SpeechSynthesisUtterance("");
    unlock.volume = 0;
    speechSynthesis.speak(unlock);
  }

  if (isListening) {
    clearRecognitionWatchdog();
    clearRecognitionSilenceTimer();
    recognitionSession++;
    try { recognition.stop(); } catch {}
    showStopListeningButton(false);
    return;
  }

  ui.userBubble.classList.add("hidden");
  ui.mimiBubble.classList.add("hidden");

  try {
    recognition.start();
  } catch (error) {
    console.warn("Recognition start:", error);
  }
}

ui.talk.addEventListener("click", startTalk);
ui.quickTalk.addEventListener("click", startTalk);
ui.chatTalk?.addEventListener("click", startTalk);

$("showChat").addEventListener("click", () => activatePage("chat"));

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

// Preload giọng TTS tiếng Việt sớm để giảm độ trễ khi AI trả lời.
if ("speechSynthesis" in window) {
  speechSynthesis.getVoices();
  setTimeout(() => {
    const voice = chooseVietnameseVoice();
    if (voice) {
      voicesReady = true;
      console.log("MIMI FAST TTS ready:", voice.name, voice.lang);
      ui.systemSpeaker.textContent = "Sẵn sàng";
    }
  }, 100);
}

// Seed a clean activity list.
[
  "MIMI đã sẵn sàng.",
  "Hệ thống khởi động hoàn tất.",
  "AI Core đang chờ lệnh."
].forEach(text => addActivity(text));

checkCore();

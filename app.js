const CONFIG = {
  // MIMI PRO WEB: LOCAL AI ONLY — không dùng Cloud AI.
  localCoreUrl: "http://192.168.1.186:3000",
  language: "vi-VN",

  
  // MIMI PRO WEB → local Xiaozhi/Edge TTS bridge.
  // The bridge tested successfully on the laptop at port 8788.
  xiaozhiTtsUrl: "http://127.0.0.1:8788/tts",
  xiaozhiTtsLanUrl: "http://192.168.1.186:8788/tts",

  // TTS timing: fail fast so MIMI can move to the next TTS path.
  // Xiaozhi is the first TTS path.
  xiaozhiTtsTimeout: 10000,
  mimiTtsTimeout: 4500,

  // Start speaking earlier while AI response is still streaming.
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
    Number(CONFIG.mimiTtsTimeout || 4500)
  );

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: value,
        language: "vi-VN",
        voice: "vi-VN-HoaiMyNeural"
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

async function speakWithXiaozhi(text) {
  // Xiaozhi TTS được ưu tiên trước.
  // Trên laptop: dùng localhost.
  // Trên điện thoại cùng Wi‑Fi: localhost là chính điện thoại, nên dùng LAN IP.
  // Nếu GitHub Pages HTTPS chặn HTTP LAN (mixed-content), hàm fail nhanh
  // để MIMI chuyển sang Worker TTS thay vì chờ lâu.
  const isLocalHost =
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1" ||
    location.hostname === "::1";

  const url = String(
    isLocalHost
      ? (CONFIG.xiaozhiTtsUrl || "")
      : (CONFIG.xiaozhiTtsLanUrl || CONFIG.xiaozhiTtsUrl || "")
  ).trim();
  if (!url) return false;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Number(CONFIG.xiaozhiTtsTimeout || 3500)
  );

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: String(text || ""),
        language: "vi-VN",
        voice: "vi-VN-HoaiMyNeural"
      }),
      cache: "no-store",
      signal: controller.signal
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(
        "Xiaozhi TTS HTTP:",
        response.status,
        detail
      );
      return false;
    }

    const contentType =
      String(response.headers.get("content-type") || "").toLowerCase();

    // Normal bridge response: audio/mpeg, audio/mp3, audio/wav, etc.
    if (contentType.includes("audio/")) {
      const blob = await response.blob();
      return await playTtsAudioBlob(blob);
    }

    // Also accept a JSON response so the bridge can return an audio URL
    // or base64 audio without requiring another change to MIMI PRO Web.
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

      console.warn("Xiaozhi TTS JSON không chứa audio:", data);
      return false;
    }

    console.warn("Xiaozhi TTS không trả về audio:", contentType);
    return false;
  } catch (error) {
    if (error?.name === "AbortError") {
      console.warn("Xiaozhi TTS timeout.");
      addActivity("⚠️ TTS Bridge phản hồi quá lâu");
    } else {
      console.warn("Xiaozhi TTS chưa sẵn sàng:", error);
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
    manualStopRequested = false;
    clearTimeout(manualStopTimer);
    ui.talk.disabled = true;
    setStatus("🤖 MIMI ĐANG SUY NGHĨ…", "idle");
    ui.systemMic.textContent = "Đang xử lý";
    showStopListeningButton(false);
    showConversation(cleanText);
    addActivity(`Bạn: ${cleanText}`);

    // Streaming TTS queue: chỉ gửi TTS khi đã có một câu/cụm đủ tự nhiên.
    const ttsQueue = [];
    let ttsRunning = false;
    let ttsFailed = false;
    let ttsBuffer = "";
    let displayedAnswer = "";

    const runTtsQueue = async () => {
      if (ttsRunning) return;
      ttsRunning = true;
      try {
        while (ttsQueue.length) {
          const chunk = ttsQueue.shift();
          // TTS priority: Xiaozhi → MIMI Worker TTS → Browser TTS.
          const ok = await speakWithXiaozhi(chunk) || await speakWithMimiWorkerTts(chunk);
          if (!ok) {
            ttsFailed = true;
            // Fallback browser TTS for the remaining stream text.
            speak(chunk);
          }
        }
      } finally {
        ttsRunning = false;
      }
    };

    const pushTtsChunk = (chunk, flush = false) => {
      ttsBuffer += String(chunk || "");

      // Ưu tiên phát theo câu, tránh TTS từng token quá vụn.
      const parts = ttsBuffer.split(/(?<=[.!?。！？])\s+/);
      if (parts.length > 1) {
        ttsBuffer = parts.pop() || "";
        for (const part of parts) {
          const value = part.trim();
          if (value) ttsQueue.push(value);
        }
      }

      // Nếu chưa gặp dấu câu, cắt mềm sớm hơn để TTS bắt đầu
      // ngay khi AI vẫn đang streaming.
      while (ttsBuffer.length >= Number(CONFIG.ttsEarlyChunkChars || 70)) {
        const limit = Number(CONFIG.ttsEarlyChunkChars || 70);
        const cut = ttsBuffer.lastIndexOf(" ", limit);
        const index = cut > 30 ? cut : limit;
        const value = ttsBuffer.slice(0, index).trim();
        ttsBuffer = ttsBuffer.slice(index).trimStart();
        if (value) ttsQueue.push(value);
      }

      if (flush && ttsBuffer.trim()) {
        ttsQueue.push(ttsBuffer.trim());
        ttsBuffer = "";
      }

      runTtsQueue();
    };

    try {
      // Primary path: always go through MIMI AI Core so Memory and
      // conversation context stay synchronized across turns.
      // getFastResponse() remains available as an emergency fallback.
      const answer = await streamMimi(cleanText, (chunk) => {
        if (!chunk) return;
        displayedAnswer += chunk;
        showConversation(cleanText, displayedAnswer);
        setCoreState(true);
        pushTtsChunk(chunk, false);
      });

      // Phần cuối chưa gặp dấu câu vẫn phải được đọc.
      pushTtsChunk("", true);

      if (!displayedAnswer.trim()) {
        displayedAnswer = answer;
        showConversation(cleanText, displayedAnswer);
      }

      addActivity(`MIMI: ${displayedAnswer}`);

      // Chờ các đoạn TTS đã xếp hàng phát xong.
      while (ttsRunning || ttsQueue.length) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      if (ttsFailed) {
        addActivity("ℹ️ TTS Bridge lỗi ở một đoạn → Browser TTS đã fallback");
      }
    } catch (error) {
      console.error("MIMI CORE ERROR:", error);

      // Emergency fallback only. Normal conversation never bypasses Core.
      const fallback = getFastResponse(cleanText);
      if (fallback) {
        displayedAnswer = fallback;
        showConversation(cleanText, displayedAnswer);
        pushTtsChunk(displayedAnswer, true);
        addActivity(`MIMI OFFLINE FAST: ${displayedAnswer}`);

        while (ttsRunning || ttsQueue.length) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }

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

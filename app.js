const CONFIG = {
  // MIMI PRO WEB: LOCAL AI ONLY — không dùng Cloud AI.
  localCoreUrl: "http://192.168.1.186:3000",
  language: "vi-VN",

  // MIMI PRO WEB → local Xiaozhi/Edge TTS bridge.
  // The bridge tested successfully on the laptop at port 8788.
  xiaozhiTtsUrl: "http://127.0.0.1:8788/tts",
  xiaozhiTtsLanUrl: "http://192.168.1.186:8788/tts",
  xiaozhiTtsTimeout: 20000
};

const $ = (id) => document.getElementById(id);

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
let recognitionSession = 0;

function clearRecognitionWatchdog() {
  if (recognitionWatchdog) {
    clearTimeout(recognitionWatchdog);
    recognitionWatchdog = null;
  }
}

// Nút DỪNG NGHE: đặc biệt cho iPhone/Safari khi Speech Recognition bị giữ mic.
// Tạo bằng JS để không phải xoá/sửa bố cục HTML hiện tại.
const stopListeningButton = document.createElement("button");
stopListeningButton.type = "button";
stopListeningButton.id = "stopListeningButton";
stopListeningButton.textContent = "⏹ Dừng nghe";
stopListeningButton.setAttribute("aria-label", "Dừng nghe");
Object.assign(stopListeningButton.style, {
  display: "none",
  margin: "10px auto 0",
  padding: "11px 20px",
  borderRadius: "999px",
  border: "1px solid rgba(190,150,255,.75)",
  background: "rgba(80,45,150,.9)",
  color: "#fff",
  fontSize: "15px",
  fontWeight: "700",
  cursor: "pointer",
  boxShadow: "0 0 18px rgba(150,90,255,.35)",
  position: "relative",
  zIndex: "20"
});

if (ui.talk && ui.talk.parentElement) {
  ui.talk.insertAdjacentElement("afterend", stopListeningButton);
}

function showStopListeningButton(show) {
  // Chỉ hiện khi MIMI thật sự đang nghe.
  stopListeningButton.style.display =
    show && isListening ? "block" : "none";
}

function stopListeningManually() {
  if (!recognition || !isListening) return;

  clearRecognitionWatchdog();
  recognitionSession++;
  addActivity("⏹ Bạn đã dừng nghe", "normal");

  try {
    recognition.stop();
  } catch (error) {
    console.warn("Recognition stop:", error);
    isListening = false;
    setStatus("MIMI đã sẵn sàng", "idle");
    ui.systemMic.textContent = "Sẵn sàng";
    showStopListeningButton(false);
  }
}

stopListeningButton.addEventListener("click", stopListeningManually);

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

async function askMimi(text) {
  const response = await fetch(CONFIG.localCoreUrl + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: text, provider: "local" }),
    cache: "no-store"
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  const data = await response.json();
  return data.reply || data.response || data.message || data.text ||
    "MIMI chưa có câu trả lời.";
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

async function speakWithXiaozhi(text) {
  // Trên laptop: dùng localhost.
  // Trên điện thoại cùng Wi‑Fi: localhost là chính điện thoại, nên dùng LAN IP.
  // Lưu ý: nếu trang MIMI PRO đang chạy HTTPS, trình duyệt có thể chặn HTTP
  // LAN do mixed-content; khi đó hàm sẽ trả false và Browser TTS sẽ fallback.
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
    Number(CONFIG.xiaozhiTtsTimeout || 20000)
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

  const value = String(text || "").trim();
  if (!value) return;

  // iPhone/Safari có thể giữ speechSynthesis ở trạng thái paused.
  speechSynthesis.cancel();
  speechSynthesis.resume();

  const voice = await waitForVietnameseVoice(3500);

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
    if (isListening && !isProcessing) {
      try { recognition.stop(); } catch {}
    }
  };

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

    if (!finalText) {
      ui.userBubble.textContent = text;
      ui.userBubble.classList.remove("hidden");
      return;
    }

    isProcessing = true;
    ui.talk.disabled = true;
    setStatus("🤖 MIMI ĐANG SUY NGHĨ…", "idle");
    ui.systemMic.textContent = "Đang xử lý";
    showConversation(finalText);
    addActivity(`Bạn: ${finalText}`);

    try {
      const answer = await askMimi(finalText);
      showConversation(finalText, answer);
      addActivity(`MIMI: ${answer}`);
      setCoreState(true);
      // Ưu tiên TTS Bridge đã test trên laptop.
      // Nếu bridge lỗi/mất → giữ nguyên Browser TTS hiện tại làm fallback.
      const usedXiaozhiTts = await speakWithXiaozhi(answer);
      if (!usedXiaozhiTts) {
        addActivity("⚠️ TTS Bridge không dùng được → chuyển sang Browser TTS");
        speak(answer);
      }
    } catch (error) {
      console.error("MIMI CORE ERROR:", error);
      setCoreState(false);
      setStatus("❌ AI CORE ERROR", "idle");
      showConversation(finalText, `Lỗi kết nối MIMI Core: ${error.message}`);
      addActivity("MIMI: Lỗi kết nối AI Core");
    } finally {
      isProcessing = false;
      ui.talk.disabled = false;
      ui.systemMic.textContent = "Sẵn sàng";
    }
  };

  recognition.onerror = (event) => {
    clearRecognitionWatchdog();
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
    recognitionSession++;
    isListening = false;
    showStopListeningButton(false);
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

// Seed a clean activity list.
[
  "MIMI đã sẵn sàng.",
  "Hệ thống khởi động hoàn tất.",
  "AI Core đang chờ lệnh."
].forEach(text => addActivity(text));

checkCore();

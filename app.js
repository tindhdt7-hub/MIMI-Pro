const CONFIG = {
  workerUrl: "https://mimi-pro-core.tindhdt7.workers.dev/chat",
  language: "vi-VN"
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
    const response = await fetch(CONFIG.workerUrl, {
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
  const response = await fetch(CONFIG.workerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: text }),
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

function chooseVietnameseVoice() {
  if (!("speechSynthesis" in window)) return null;

  const voices = speechSynthesis.getVoices();

  // Ưu tiên tuyệt đối giọng tiếng Việt.
  return (
    voices.find(v => /^vi(-|_)/i.test(String(v.lang || ""))) ||
    voices.find(v => /Vietnamese|Tiếng Việt|Vietnam/i.test(String(v.name || ""))) ||
    null
  );
}

let ttsAudio = null;
let ttsUnlocked = false;

function unlockVietnameseAudio() {
  // Tạo audio element một lần để iPhone/Safari cho phép phát âm thanh
  // sau khi người dùng bấm nút microphone.
  if (!ttsAudio) {
    ttsAudio = new Audio();
    ttsAudio.preload = "auto";
    ttsAudio.playsInline = true;
  }

  try {
    ttsAudio.muted = true;
    const p = ttsAudio.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
    ttsAudio.pause();
    ttsAudio.currentTime = 0;
    ttsUnlocked = true;
  } catch (_) {}
}

function speakVietnameseFallback(text) {
  // Đây là TTS tiếng Việt, không phải AI Cloud.
  // Dùng khi Windows/Chrome không có voice vi-VN cài sẵn.
  if (!ttsAudio) {
    ttsAudio = new Audio();
    ttsAudio.playsInline = true;
  }

  const cleanText = String(text || "").trim();
  if (!cleanText) return;

  const url =
    "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=vi&q=" +
    encodeURIComponent(cleanText);

  ttsAudio.pause();
  ttsAudio.currentTime = 0;
  ttsAudio.src = url;
  ttsAudio.muted = false;
  ttsAudio.volume = 1;

  ttsAudio.onplay = () => {
    setStatus("🔊 MIMI ĐANG NÓI…", "speaking");
    ui.systemSpeaker.textContent = "Đang nói";
  };

  ttsAudio.onended = () => {
    ui.systemSpeaker.textContent = "Sẵn sàng";
    setStatus("Mình đang sẵn sàng", "idle");
  };

  ttsAudio.onerror = (event) => {
    console.error("Vietnamese fallback TTS ERROR:", event);
    ui.systemSpeaker.textContent = "TTS lỗi";
    setStatus("❌ Không phát được tiếng Việt", "idle");
  };

  const playPromise = ttsAudio.play();
  if (playPromise && typeof playPromise.catch === "function") {
    playPromise.catch(error => {
      console.error("Vietnamese TTS play blocked:", error);
      ui.systemSpeaker.textContent = "Chưa được phép phát âm thanh";
      addActivity("⚠️ Hãy bấm Gọi MIMI rồi thử lại để mở âm thanh.");
      setStatus("⚠️ Hãy bấm mic để bật âm thanh", "idle");
    });
  }
}

function speak(text) {
  const cleanText = String(text || "").trim();
  if (!cleanText) return;

  if ("speechSynthesis" in window) {
    speechSynthesis.cancel();

    const voice = chooseVietnameseVoice();

    // Nếu thiết bị có voice vi-VN thật, dùng native TTS.
    if (voice) {
      const utterance = new SpeechSynthesisUtterance(cleanText);
      utterance.voice = voice;
      utterance.lang = "vi-VN";
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

      utterance.onerror = (event) => {
        console.error("Native Vietnamese TTS ERROR:", event);
        speakVietnameseFallback(cleanText);
      };

      speechSynthesis.speak(utterance);
      return;
    }
  }

  // Máy không có voice vi-VN: tuyệt đối không cho rơi sang giọng Anh.
  addActivity("TTS: không có voice vi-VN, dùng bộ phát tiếng Việt dự phòng.");
  speakVietnameseFallback(cleanText);
}

if ("speechSynthesis" in window) {
  speechSynthesis.onvoiceschanged = () => {
    voicesReady = true;
    console.log(
      "MIMI Vietnamese voices:",
      speechSynthesis.getVoices()
        .filter(v => /^vi(-|_)/i.test(String(v.lang || "")))
        .map(v => `${v.name} (${v.lang})`)
    );
  };
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
  };

  recognition.onspeechstart = () => {
    setStatus("👂 MIMI ĐANG NGHE GIỌNG…", "listening");
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
      speak(answer);
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
    isListening = false;
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
    isListening = false;
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

  // Mở quyền phát âm thanh ngay trong thao tác bấm mic.
  unlockVietnameseAudio();

  if ("speechSynthesis" in window) {
    speechSynthesis.cancel();
  }

  if (isListening) {
    recognition.stop();
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

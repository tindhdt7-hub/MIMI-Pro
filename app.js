const CONFIG = {
  // MIMI PRO Web -> MIMI AI Core Local on this PC.
  // Do NOT use Cloud Worker / Gemini for this voice test.
  localCoreUrl: "http://127.0.0.1:3000",
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
let micStream = null;
let voicesReady = false;

function setStatus(text, mode = "idle") {
  ui.status.textContent = text;
  ui.stage.classList.toggle("listening", mode === "listening");
  ui.stage.classList.toggle("speaking", mode === "speaking");
  ui.talk.classList.toggle("listening", mode === "listening");

  const icon = ui.talk.querySelector(".mic-icon");
  if (icon) icon.textContent = mode === "listening" ? "⏹" : "🎙";
}

function updateClock() {
  const now = new Date();
  const value = now.toLocaleTimeString("vi-VN");
  ui.clock.textContent = value;
  ui.statusClock.textContent = value;
}
updateClock();
setInterval(updateClock, 1000);

function addActivity(text) {
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
  ui.coreConnection.textContent = online ? "Đã kết nối" : "Mất kết nối";
  ui.coreConnection.style.color =
    online ? "var(--green)" : "var(--danger)";

  ui.aiCoreStatus.textContent = online ? "Online ●" : "Offline ●";
  ui.aiCoreStatus.style.color =
    online ? "var(--green)" : "var(--danger)";

  ui.systemCore.textContent = online ? "Online" : "Offline";
  ui.systemCore.style.color =
    online ? "var(--green)" : "var(--danger)";
}

/*
  LOCAL CORE ONLY
  MIMI PRO Web -> http://127.0.0.1:3000/api/chat
*/
async function checkCore() {
  try {
    const response = await fetch(`${CONFIG.localCoreUrl}/`, {
      method: "GET",
      cache: "no-store"
    });

    setCoreState(response.ok);
    addActivity(
      response.ok
        ? "🧠 MIMI Local AI Core: ONLINE"
        : `❌ Local AI Core HTTP ${response.status}`
    );
  } catch (error) {
    setCoreState(false);
    addActivity("❌ Không kết nối Local AI Core: " + error.message);
  }
}

async function askMimi(text) {
  const response = await fetch(`${CONFIG.localCoreUrl}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: text,
      provider: "local"
    }),
    cache: "no-store"
  });

  const raw = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${raw}`);
  }

  let data = {};
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Local AI trả về dữ liệu không phải JSON: " + raw);
  }

  return (
    data.reply ||
    data.response ||
    data.message ||
    data.content ||
    data.text ||
    "MIMI chưa nhận được câu trả lời."
  );
}

function chooseVietnameseVoice() {
  if (!("speechSynthesis" in window)) return null;

  const voices = window.speechSynthesis.getVoices();

  return (
    voices.find(v => /^vi(-|_)/i.test(v.lang)) ||
    voices.find(v =>
      /Vietnam|Vietnamese|Tiếng Việt/i.test(v.name)
    ) ||
    null
  );
}

/*
  TTS LOCAL BROWSER
  No Xiaozhi TTS / no Cloud TTS.
*/
function speak(text) {
  if (!("speechSynthesis" in window)) {
    ui.systemSpeaker.textContent = "Không hỗ trợ TTS";
    addActivity("❌ Trình duyệt không hỗ trợ SpeechSynthesis");
    return;
  }

  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = CONFIG.language;
  utterance.rate = 0.95;
  utterance.pitch = 1;
  utterance.volume = 1;

  const voice = chooseVietnameseVoice();

  if (voice) {
    utterance.voice = voice;
    addActivity(`🔊 TTS: ${voice.name} (${voice.lang})`);
  } else {
    addActivity("🔊 TTS: vi-VN / voice mặc định");
  }

  utterance.onstart = () => {
    setStatus("🔊 MIMI ĐANG NÓI…", "speaking");
    ui.systemSpeaker.textContent = "Đang nói";
  };

  utterance.onend = () => {
    setStatus("Minh đang sẵn sàng", "idle");
    ui.systemSpeaker.textContent = "Sẵn sàng";
  };

  utterance.onerror = (event) => {
    console.error("[MIMI TTS]", event);
    ui.systemSpeaker.textContent = "Lỗi loa";
    addActivity("❌ TTS ERROR: " + (event.error || "unknown"));
    setStatus("⚠️ MIMI không phát được loa", "idle");
  };

  window.speechSynthesis.speak(utterance);
}

if ("speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = () => {
    voicesReady = true;
  };
}

/*
  MICROPHONE
  We explicitly request the microphone first.
  This makes the permission/error visible instead of silently doing nothing.
*/
async function requestMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Trình duyệt không hỗ trợ microphone.");
  }

  if (micStream) return;

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1
    },
    video: false
  });

  addActivity("🎤 Microphone đã được cấp quyền");
}

/*
  VIETNAMESE STT
  SpeechRecognition -> visible text -> Local AI -> Browser TTS.
*/
const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

if (SpeechRecognition) {
  recognition = new SpeechRecognition();

  recognition.lang = "vi-VN";
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    isListening = true;

    setStatus("🎤 MIMI ĐANG THU TIẾNG VIỆT…", "listening");
    ui.systemMic.textContent = "Đang thu tiếng";
    ui.systemSpeaker.textContent = "Sẵn sàng";

    ui.userBubble.textContent = "Đang nghe…";
    ui.userBubble.classList.remove("hidden");

    addActivity("🎤 STT bắt đầu — vi-VN");
  };

  recognition.onspeechstart = () => {
    setStatus("👂 MIMI ĐANG NGHE GIỌNG…", "listening");
  };

  recognition.onresult = async (event) => {
    let finalText = "";
    let interimText = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const chunk = result?.[0]?.transcript || "";

      if (result.isFinal) {
        finalText += chunk;
      } else {
        interimText += chunk;
      }
    }

    const visibleText = (finalText || interimText).trim();

    if (visibleText) {
      // ALWAYS show the text we heard.
      ui.userBubble.textContent = visibleText;
      ui.userBubble.classList.remove("hidden");
    }

    if (!finalText.trim()) return;

    const text = finalText.trim();

    isProcessing = true;
    ui.talk.disabled = true;

    setStatus("📝 ĐÃ THU XONG — ĐANG GỬI LOCAL AI…", "idle");
    ui.systemMic.textContent = "Đã thu + có văn bản";

    showConversation(text);
    addActivity("📝 Văn bản thu được: " + text);

    try {
      const answer = await askMimi(text);

      showConversation(text, answer);
      addActivity("MIMI Local AI: " + answer);

      setCoreState(true);

      // Speak the Local AI answer.
      speak(answer);
    } catch (error) {
      console.error("[MIMI LOCAL CORE]", error);

      setCoreState(false);
      setStatus("❌ LOCAL AI ERROR", "idle");
      ui.systemSpeaker.textContent = "Lỗi";

      showConversation(
        text,
        "MIMI nghe được rồi nhưng Local AI chưa trả lời: " +
        error.message
      );

      addActivity("❌ Local AI: " + error.message);
    } finally {
      isProcessing = false;
      ui.talk.disabled = false;
      ui.systemMic.textContent = "Sẵn sàng";
    }
  };

  recognition.onerror = (event) => {
    isListening = false;
    ui.talk.disabled = false;

    const error = event.error || "unknown";

    console.error("[MIMI STT]", error);
    addActivity("❌ STT ERROR: " + error);

    if (error === "not-allowed" || error === "permission-denied") {
      setStatus("❌ CHƯA CẤP QUYỀN MICROPHONE", "idle");
    } else if (error === "service-not-allowed") {
      setStatus("❌ TRÌNH DUYỆT CHẶN SPEECH RECOGNITION", "idle");
    } else if (error === "no-speech") {
      setStatus("⚠️ MIMI KHÔNG NGHE THẤY GIỌNG", "idle");
    } else if (error === "network") {
      setStatus("❌ SPEECH RECOGNITION LỖI MẠNG", "idle");
    } else {
      setStatus(`❌ STT: ${error}`, "idle");
    }

    ui.systemMic.textContent = "Lỗi";
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

    addActivity("🎤 STT kết thúc");
  };
} else {
  ui.systemMic.textContent = "Không hỗ trợ";

  setStatus(
    "❌ TRÌNH DUYỆT KHÔNG HỖ TRỢ SPEECH RECOGNITION",
    "idle"
  );

  addActivity("❌ SpeechRecognition / webkitSpeechRecognition không có");
}

async function startTalk() {
  // Unlock browser audio while still inside the user's click gesture.
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();

    const unlock = new SpeechSynthesisUtterance("");
    unlock.volume = 0;

    try {
      window.speechSynthesis.speak(unlock);
    } catch {}
  }

  if (!recognition) {
    setStatus("❌ Không có Speech Recognition", "idle");
    return;
  }

  if (isProcessing) {
    addActivity("⏳ MIMI đang xử lý câu trước");
    return;
  }

  if (isListening) {
    try {
      recognition.stop();
    } catch {}
    return;
  }

  try {
    // Explicit microphone permission first.
    await requestMicrophone();

    ui.userBubble.classList.add("hidden");
    ui.mimiBubble.classList.add("hidden");

    // recognition.start() MUST happen after the user click.
    recognition.start();

  } catch (error) {
    console.error("[MIMI MIC START]", error);

    setStatus("❌ KHÔNG MỞ ĐƯỢC MICROPHONE", "idle");
    ui.systemMic.textContent = "Lỗi";
    addActivity("❌ Microphone: " + error.message);
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

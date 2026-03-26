// frontend/src/App.jsx
import { useState, useRef, useEffect, useCallback } from "react";
import { useSignaling } from "./useSignaling";
import { useWebRTC } from "./useWebRTC";
import "./App.css";

const genClientId = () => crypto.randomUUID().slice(0, 8);

const buildInviteLink = (key) =>
  `${window.location.origin}?session=${key}`;

const getSessionFromUrl = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get("session");
};

const copyToClipboard = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

/* ── SVG-иконки ── */

const Icon = ({ d, size = 20, ...props }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    {typeof d === "string" ? <path d={d} /> : d}
  </svg>
);

const Icons = {
  mic: <Icon d={<><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></>} />,
  micOff: <Icon d={<><line x1="2" y1="2" x2="22" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" y1="19" x2="12" y2="22"/></>} />,
  cam: <Icon d={<><path d="M15 10l4.553-2.276A1 1 0 0 1 21 8.618v6.764a1 1 0 0 1-1.447.894L15 14"/><rect x="1" y="6" width="14" height="12" rx="2" ry="2"/></>} />,
  camOff: <Icon d={<><line x1="2" y1="2" x2="22" y2="22"/><path d="M15 10l4.553-2.276A1 1 0 0 1 21 8.618v6.764a1 1 0 0 1-1.447.894L15 14"/><path d="M11.584 6H13a2 2 0 0 1 2 2v3.584"/><path d="M3 3l2.602 2.602A2 2 0 0 0 3 8v8a2 2 0 0 0 2 2h8"/></>} />,
  screen: <Icon d={<><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></>} />,
  screenOff: <Icon d={<><rect x="2" y="3" width="20" height="14" rx="2" ry="2" fill="currentColor" opacity="0.15"/><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></>} />,
  hangup: <Icon d={<><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 2.59 3.4Z"/><line x1="1" y1="1" x2="23" y2="23"/></>} />,
  volumeOff: <Icon d={<><path d="M11 5 6 9H2v6h4l5 4V5Z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></>} />,
  volumeLow: <Icon d={<><path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></>} />,
  volumeHigh: <Icon d={<><path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></>} />,
  link: <Icon d={<><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></>} />,
  check: <Icon d={<><polyline points="20 6 9 17 4 12"/></>} />,
  user: <Icon d={<><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></>} />,
  video: <Icon d={<><path d="M15 10l4.553-2.276A1 1 0 0 1 21 8.618v6.764a1 1 0 0 1-1.447.894L15 14"/><rect x="1" y="6" width="14" height="12" rx="2" ry="2"/></>} />,
  chat: <Icon d={<><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></>} />,
  send: <Icon d={<><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></>} />,
};

/* ── Компонент видео ── */

function Video({ stream, muted = false, volume = 1, className = "", adaptAspect = false }) {
  const containerRef = useRef(null);
  const cleanupRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !stream) return;

    if (cleanupRef.current) cleanupRef.current();
    container.querySelectorAll("video, canvas").forEach((el) => el.remove());

    const el = document.createElement("video");
    el.playsInline = true;
    el.autoplay = true;
    el.muted = true;
    el.setAttribute("playsinline", "");
    el.setAttribute("webkit-playsinline", "");
    el.srcObject = stream;
    container.prepend(el);

    const updateAspect = () => {
      if (!adaptAspect || !el.videoWidth || !el.videoHeight) return;
      container.style.aspectRatio = `${el.videoWidth} / ${el.videoHeight}`;
    };
    el.addEventListener("resize", updateAspect);
    el.addEventListener("loadedmetadata", updateAspect);

    const playPromise = el.play();
    let fallbackTimer = null;
    let canvasRAF = null;

    if (playPromise) {
      playPromise.then(() => {
        if (!muted) {
          el.muted = false;
          el.volume = volume;
        }
        updateAspect();
      }).catch(() => {});
    }

    fallbackTimer = setTimeout(() => {
      if (el.videoWidth > 0) return;
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack || typeof ImageCapture === "undefined") return;

      const capture = new ImageCapture(videoTrack);
      const canvas = document.createElement("canvas");
      el.style.display = "none";
      container.prepend(canvas);
      const ctx = canvas.getContext("2d");
      let running = true;
      async function drawLoop() {
        if (!running) return;
        try {
          const bitmap = await capture.grabFrame();
          if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
          if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          if (adaptAspect) {
            container.style.aspectRatio = `${bitmap.width} / ${bitmap.height}`;
          }
        } catch { /* ended */ }
        canvasRAF = requestAnimationFrame(drawLoop);
      }
      drawLoop();
      cleanupRef.current = () => {
        running = false;
        if (canvasRAF) cancelAnimationFrame(canvasRAF);
        el.srcObject = null;
        canvas.remove();
        el.remove();
      };
    }, 1500);

    cleanupRef.current = () => {
      clearTimeout(fallbackTimer);
      if (canvasRAF) cancelAnimationFrame(canvasRAF);
      el.removeEventListener("resize", updateAspect);
      el.removeEventListener("loadedmetadata", updateAspect);
      el.srcObject = null;
      el.remove();
    };

    return () => { if (cleanupRef.current) cleanupRef.current(); };
  }, [stream, adaptAspect]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const el = container.querySelector("video");
    if (!el) return;
    el.muted = muted;
    if (!muted) el.volume = volume;
  }, [muted, volume]);

  return <div className={className} ref={containerRef} />;
}

/* ── Лобби ── */

function Lobby({ onJoin, initialKey }) {
  const [key, setKey] = useState(initialKey || "");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  useEffect(() => {
    if (initialKey) onJoin(initialKey, false);
  }, [initialKey, onJoin]);

  const handleCreate = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/sessions", { method: "POST" });
      const data = await res.json();
      if (data.error) {
        setErrorMsg(data.message);
        return;
      }
      await copyToClipboard(buildInviteLink(data.sessionKey));
      onJoin(data.sessionKey, true);
    } finally {
      setLoading(false);
    }
  };

  const handleJoin = () => {
    const trimmed = key.trim();
    if (trimmed) onJoin(trimmed, false);
  };

  return (
    <div className="lobby">
      <div className="lobby-logo">
        {Icons.video}
      </div>
      <h1>Video Bridge</h1>
      <p className="subtitle">Видеомост для двоих</p>

      {errorMsg && <p className="lobby-error">{errorMsg}</p>}

      <button className="btn btn-primary" onClick={handleCreate} disabled={loading}>
        {loading ? "Создаю…" : "Создать сессию"}
      </button>

      <div className="divider">или</div>

      <div className="join-row">
        <input
          type="text"
          placeholder="Ключ сессии"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleJoin()}
        />
        <button className="btn btn-secondary" onClick={handleJoin} disabled={!key.trim()}>
          Войти
        </button>
      </div>
    </div>
  );
}

/* ── Панель управления ── */

function MediaControls({
  localStream, volume, onVolumeChange, onHangUp,
  isScreenSharing, onStartScreen, onStopScreen, hidden,
  chatOpen, onToggleChat, unreadCount,
}) {
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);

  const toggleCam = () => {
    if (!localStream) return;
    const track = localStream.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCamOn(track.enabled);
  };

  const toggleMic = () => {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMicOn(track.enabled);
  };

  return (
    <div className={`controls-bar ${hidden ? "controls-hidden" : ""}`}>
      <button
        className={`ctrl-btn ${micOn ? "" : "ctrl-off"}`}
        onClick={toggleMic}
        title={micOn ? "Выключить микрофон" : "Включить микрофон"}
      >
        {micOn ? Icons.mic : Icons.micOff}
      </button>

      <button
        className={`ctrl-btn ${camOn ? "" : "ctrl-off"}`}
        onClick={toggleCam}
        title={camOn ? "Выключить камеру" : "Включить камеру"}
      >
        {camOn ? Icons.cam : Icons.camOff}
      </button>

      <button
        className={`ctrl-btn ${isScreenSharing ? "ctrl-active" : ""}`}
        onClick={isScreenSharing ? onStopScreen : onStartScreen}
        title={isScreenSharing ? "Остановить демонстрацию" : "Демонстрация экрана"}
      >
        {isScreenSharing ? Icons.screenOff : Icons.screen}
      </button>

      <div className="controls-sep" />

      <div className="volume-control">
        <button className="volume-btn" onClick={() => onVolumeChange(volume === 0 ? 1 : 0)}
          title={volume === 0 ? "Включить звук" : "Выключить звук"}>
          {volume === 0 ? Icons.volumeOff : volume < 0.5 ? Icons.volumeLow : Icons.volumeHigh}
        </button>
        <input
          type="range" min="0" max="1" step="0.05"
          value={volume}
          onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
        />
      </div>

      <button
        className={`ctrl-btn ${chatOpen ? "ctrl-active" : ""}`}
        onClick={onToggleChat}
        title="Чат"
        style={{ position: "relative" }}
      >
        {Icons.chat}
        {unreadCount > 0 && <span className="chat-badge">{unreadCount}</span>}
      </button>

      <div className="controls-sep" />

      <button className="ctrl-btn ctrl-hangup" onClick={onHangUp} title="Завершить">
        {Icons.hangup}
      </button>
    </div>
  );
}

/* ── Чат ── */

function Chat({ messages, onSend, open, onClose }) {
  const [text, setText] = useState("");
  const listRef = useRef(null);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages]);

  const handleSend = () => {
    if (!text.trim()) return;
    onSend(text);
    setText("");
  };

  if (!open) return null;

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span>Чат</span>
        <button className="chat-close" onClick={onClose}>✕</button>
      </div>
      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 && <div className="chat-empty">Нет сообщений</div>}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.own ? "chat-own" : "chat-peer"}`}>
            {m.text}
          </div>
        ))}
      </div>
      <div className="chat-input">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          placeholder="Сообщение..."
        />
        <button onClick={handleSend} disabled={!text.trim()}>{Icons.send}</button>
      </div>
    </div>
  );
}

/* ── Видеозвонок ── */

const STATUS_TEXT = {
  idle: "Подготовка…",
  waiting: "Ожидание собеседника…",
  connecting: "Соединение…",
  connected: "Подключено",
  reconnecting: "Переподключение…",
  disconnected: "Собеседник отключился",
};

function Call({
  sessionKey, localStream, remoteStream, status, onHangUp,
  isCreator, isScreenSharing, onStartScreen, onStopScreen,
  chatMessages, onSendChat,
}) {
  const [peerVolume, setPeerVolume] = useState(1);
  const [copied, setCopied] = useState(false);
  const [controlsHidden, setControlsHidden] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const hideTimerRef = useRef(null);
  const lastReadRef = useRef(0);
  const statusMsg = STATUS_TEXT[status] ?? status;

  useEffect(() => {
    if (chatOpen) {
      lastReadRef.current = chatMessages.length;
      setUnread(0);
    } else {
      const n = chatMessages.length - lastReadRef.current;
      if (n > 0) setUnread(n);
    }
  }, [chatMessages.length, chatOpen]);

  // Auto-hide контролов при бездействии
  const resetHideTimer = useCallback(() => {
    setControlsHidden(false);
    clearTimeout(hideTimerRef.current);
    if (status === "connected") {
      hideTimerRef.current = setTimeout(() => setControlsHidden(true), 4000);
    }
  }, [status]);

  useEffect(() => {
    resetHideTimer();
    return () => clearTimeout(hideTimerRef.current);
  }, [resetHideTimer]);

  useEffect(() => {
    const handler = () => resetHideTimer();
    window.addEventListener("mousemove", handler);
    window.addEventListener("touchstart", handler);
    return () => {
      window.removeEventListener("mousemove", handler);
      window.removeEventListener("touchstart", handler);
    };
  }, [resetHideTimer]);

  const handleCopyLink = async () => {
    const ok = await copyToClipboard(buildInviteLink(sessionKey));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="call" onMouseMove={resetHideTimer}>
      {remoteStream ? (
        <Video stream={remoteStream} volume={peerVolume} className="remote-video" />
      ) : (
        <div className="remote-video remote-placeholder">
          <div className="placeholder-icon">
            {Icons.user}
          </div>
        </div>
      )}

      {localStream && (
        <Video stream={localStream} muted className="pip-video" adaptAspect />
      )}

      {statusMsg && (
        <div className={`status-overlay status-${status}`}>
          <span className="status-dot" />
          {statusMsg}
        </div>
      )}

      <div className="top-bar">
        <span className="session-badge">{sessionKey}</span>
        <button className={`copy-link-btn ${copied ? "copied" : ""}`} onClick={handleCopyLink}>
          {copied ? Icons.check : Icons.link}
          {copied ? "Скопировано" : "Скопировать ссылку"}
        </button>
      </div>

      <MediaControls
        localStream={localStream}
        volume={peerVolume}
        onVolumeChange={setPeerVolume}
        onHangUp={onHangUp}
        isScreenSharing={isScreenSharing}
        onStartScreen={onStartScreen}
        onStopScreen={onStopScreen}
        hidden={controlsHidden}
        chatOpen={chatOpen}
        onToggleChat={() => setChatOpen(o => !o)}
        unreadCount={unread}
      />

      <Chat messages={chatMessages} onSend={onSendChat} open={chatOpen} onClose={() => setChatOpen(false)} />
    </div>
  );
}

/* ── Корневой компонент ── */

export default function App() {
  const [sessionKey, setSessionKey] = useState(null);
  const [isCreator, setIsCreator] = useState(false);
  const signaling = useSignaling();
  const {
    localStream, remoteStream, status, error, cleanup,
    isScreenSharing, startScreenShare, stopScreenShare,
    chatMessages, sendChat,
  } = useWebRTC(signaling);

  const urlSessionKey = getSessionFromUrl();

  const handleJoin = useCallback(
    (key, creator = false) => {
      setSessionKey(key);
      setIsCreator(creator);
      const url = new URL(window.location.href);
      url.searchParams.set("session", key);
      window.history.replaceState(null, "", url.toString());
      signaling.connect(key, genClientId());
    },
    [signaling],
  );

  const handleHangUp = useCallback(() => {
    cleanup();
    signaling.disconnect();
    setSessionKey(null);
    setIsCreator(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("session");
    window.history.replaceState(null, "", url.pathname);
  }, [cleanup, signaling]);

  if (error) {
    return (
      <div className="lobby">
        <h2>Ошибка</h2>
        <p>{error}</p>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>
          Перезагрузить
        </button>
      </div>
    );
  }

  if (!sessionKey) {
    return <Lobby onJoin={handleJoin} initialKey={urlSessionKey} />;
  }

  return (
    <Call
      sessionKey={sessionKey}
      localStream={localStream}
      remoteStream={remoteStream}
      status={status}
      onHangUp={handleHangUp}
      isCreator={isCreator}
      isScreenSharing={isScreenSharing}
      onStartScreen={startScreenShare}
      onStopScreen={stopScreenShare}
      chatMessages={chatMessages}
      onSendChat={sendChat}
    />
  );
}

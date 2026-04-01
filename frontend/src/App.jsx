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

/* ── Видео-компонент ──────────────────────────────────────────────── */

function Video({ stream, muted = false, volume = 1, className = "", adaptAspect = false }) {
  const videoRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    if (!stream) {
      el.srcObject = null;
      return;
    }

    // Переназначаем srcObject только если стрим сменился
    if (el.srcObject !== stream) {
      el.srcObject = stream;
    }

    const play = () => {
      el.play().catch(() => {
        // Autoplay blocked — попробуем muted
        el.muted = true;
        el.play().catch(() => {});
      });
    };
    play();

    return () => {
      el.srcObject = null;
    };
  }, [stream]);

  // Громкость и mute — отдельный effect чтобы не пересоздавать видео
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = muted;
    if (!muted) el.volume = volume;
  }, [muted, volume]);

  // Адаптация aspect-ratio контейнера
  useEffect(() => {
    if (!adaptAspect) return;
    const el = videoRef.current;
    const container = containerRef.current;
    if (!el || !container) return;

    const updateAspect = () => {
      if (el.videoWidth && el.videoHeight) {
        container.style.aspectRatio = `${el.videoWidth} / ${el.videoHeight}`;
      }
    };

    el.addEventListener("resize", updateAspect);
    el.addEventListener("loadedmetadata", updateAspect);
    return () => {
      el.removeEventListener("resize", updateAspect);
      el.removeEventListener("loadedmetadata", updateAspect);
    };
  }, [adaptAspect]);

  return (
    <div className={className} ref={containerRef}>
      <video
        ref={videoRef}
        playsInline
        autoPlay
        muted={muted}
      />
    </div>
  );
}

/* ── Лобби ────────────────────────────────────────────────────────── */

function Lobby({ onJoin, initialKey }) {
  const [key, setKey] = useState(initialKey || "");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const joinedRef = useRef(false);

  // Автоподключение по ссылке — один раз
  useEffect(() => {
    if (initialKey && !joinedRef.current) {
      joinedRef.current = true;
      onJoin(initialKey, false);
    }
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
    } catch {
      setErrorMsg("Не удалось создать сессию. Проверьте соединение.");
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
      <h1>Video Bridge</h1>
      <p className="subtitle">WebRTC видеомост для двоих</p>

      {errorMsg && <p className="lobby-error">{errorMsg}</p>}

      <button className="btn btn-primary" onClick={handleCreate} disabled={loading}>
        {loading ? "Создаю..." : "Создать сессию"}
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
          Подключиться
        </button>
      </div>
    </div>
  );
}

/* ── Панель управления ────────────────────────────────────────────── */

function MediaControls({
  localStream, volume, onVolumeChange, onHangUp,
  isScreenSharing, onStartScreen, onStopScreen,
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
    <div className="controls-bar">
      <button
        className={`ctrl-btn ${micOn ? "" : "ctrl-off"}`}
        onClick={toggleMic}
        title={micOn ? "Выключить микрофон" : "Включить микрофон"}
      >
        {micOn ? "\u{1F3A4}" : "\u{1F507}"}
      </button>

      <button
        className={`ctrl-btn ${camOn ? "" : "ctrl-off"}`}
        onClick={toggleCam}
        title={camOn ? "Выключить камеру" : "Включить камеру"}
      >
        {camOn ? "\u{1F4F7}" : "\u{1F6AB}"}
      </button>

      <button
        className={`ctrl-btn ${isScreenSharing ? "ctrl-active" : ""}`}
        onClick={isScreenSharing ? onStopScreen : onStartScreen}
        title={isScreenSharing ? "Остановить демонстрацию" : "Демонстрация экрана"}
      >
        {isScreenSharing ? "\u{1F7E9}" : "\u{1F5A5}\u{FE0F}"}
      </button>

      <div className="volume-control">
        <span className="volume-icon">
          {volume === 0 ? "\u{1F507}" : volume < 0.5 ? "\u{1F509}" : "\u{1F50A}"}
        </span>
        <input
          type="range" min="0" max="1" step="0.05"
          value={volume}
          onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
        />
      </div>

      <button className="ctrl-btn ctrl-hangup" onClick={onHangUp} title="Завершить">
        {"\u{1F4F5}"}
      </button>
    </div>
  );
}

/* ── Видеозвонок ──────────────────────────────────────────────────── */

const STATUS_TEXT = {
  idle: "Подготовка…",
  waiting: "Ожидание собеседника…",
  connecting: "Соединение…",
  connected: "",
  reconnecting: "Переподключение…",
  disconnected: "Собеседник отключился",
};

function Call({
  sessionKey, localStream, remoteStream, status, onHangUp,
  isCreator, isScreenSharing, onStartScreen, onStopScreen,
}) {
  const [peerVolume, setPeerVolume] = useState(1);
  const [copied, setCopied] = useState(false);
  const statusMsg = STATUS_TEXT[status] ?? status;

  const handleCopyLink = async () => {
    const ok = await copyToClipboard(buildInviteLink(sessionKey));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="call">
      {remoteStream ? (
        <Video stream={remoteStream} volume={peerVolume} className="remote-video" />
      ) : (
        <div className="remote-video remote-placeholder">
          <span>{statusMsg || "Ожидание собеседника…"}</span>
        </div>
      )}

      {localStream && (
        <Video stream={localStream} muted className="pip-video" adaptAspect />
      )}

      {statusMsg && (
        <div className={`status-overlay status-${status}`}>{statusMsg}</div>
      )}

      <div className="top-bar">
        <span className="session-badge">{sessionKey}</span>
        <button className="copy-link-btn" onClick={handleCopyLink}>
          {copied ? "\u{2705} Скопировано" : "\u{1F517} Скопировать ссылку"}
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
      />
    </div>
  );
}

/* ── Корневой компонент ───────────────────────────────────────────── */

export default function App() {
  const [sessionKey, setSessionKey] = useState(null);
  const [isCreator, setIsCreator] = useState(false);
  const signaling = useSignaling();
  const {
    localStream, remoteStream, status, error, cleanup,
    isScreenSharing, startScreenShare, stopScreenShare,
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
    />
  );
}
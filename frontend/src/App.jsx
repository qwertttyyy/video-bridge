import { useState, useRef, useEffect, useCallback } from "react";
import { useSignaling } from "./useSignaling";
import { useWebRTC } from "./useWebRTC";
import "./App.css";

const genClientId = () => crypto.randomUUID().slice(0, 8);

/* ── Компонент видео-элемента ─────────────────────────────────────── */

function Video({ stream, muted = false, volume = 1, className = "" }) {
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

    const playPromise = el.play();

    let fallbackTimer = null;
    let canvasRAF = null;

    if (playPromise) {
      playPromise.then(() => {
        if (!muted) {
          el.muted = false;
          el.volume = volume;
        }
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
        } catch (e) { /* трек ended */ }
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
      el.srcObject = null;
      el.remove();
    };

    return () => {
      if (cleanupRef.current) cleanupRef.current();
    };
  }, [stream]);

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

/* ── Лобби ────────────────────────────────────────────────────────── */

function Lobby({ onJoin }) {
  const [key, setKey] = useState("");
  const [loading, setLoading] = useState(false);

  const handleCreate = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/sessions", { method: "POST" });
      const data = await res.json();
      onJoin(data.sessionKey);
    } finally {
      setLoading(false);
    }
  };

  const handleJoin = () => {
    const trimmed = key.trim();
    if (trimmed) onJoin(trimmed);
  };

  return (
    <div className="lobby">
      <h1>Video Bridge</h1>
      <p className="subtitle">WebRTC видеомост для двоих</p>

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

function MediaControls({ localStream, volume, onVolumeChange, onHangUp }) {
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

      <div className="volume-control">
        <span className="volume-icon">
          {volume === 0 ? "\u{1F507}" : volume < 0.5 ? "\u{1F509}" : "\u{1F50A}"}
        </span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={volume}
          onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
        />
      </div>

      <button className="ctrl-btn ctrl-hangup" onClick={onHangUp} title="Завершить">
        {'\u{1F4F5}'}
      </button>
    </div>
  );
}

/* ── Видеозвонок ──────────────────────────────────────────────────── */

const STATUS_TEXT = {
  idle: "Подготовка…",
  waiting: "Ожидание собеседника…",
  connecting: "Устанавливаю соединение…",
  connected: "",
  reconnecting: "Переподключение…",
  disconnected: "Собеседник отключился",
};

function Call({ sessionKey, localStream, remoteStream, status, onHangUp }) {
  const [peerVolume, setPeerVolume] = useState(1);
  const statusMsg = STATUS_TEXT[status] ?? status;

  return (
    <div className="call">
      {/* Большое видео собеседника (или заглушка) */}
      {remoteStream ? (
        <Video
          stream={remoteStream}
          volume={peerVolume}
          className="remote-video"
        />
      ) : (
        <div className="remote-video remote-placeholder">
          <span>{statusMsg || "Ожидание собеседника…"}</span>
        </div>
      )}

      {/* Маленькое своё видео — PiP */}
      {localStream && (
        <Video stream={localStream} muted className="pip-video" />
      )}

      {/* Статус-бар поверх видео */}
      {statusMsg && (
        <div className={`status-overlay status-${status}`}>
          {statusMsg}
        </div>
      )}

      {/* Ключ сессии */}
      <div className="session-badge">{sessionKey}</div>

      {/* Панель кнопок */}
      <MediaControls
        localStream={localStream}
        volume={peerVolume}
        onVolumeChange={setPeerVolume}
        onHangUp={onHangUp}
      />
    </div>
  );
}

/* ── Корневой компонент ───────────────────────────────────────────── */

export default function App() {
  const [sessionKey, setSessionKey] = useState(null);
  const signaling = useSignaling();
  const { localStream, remoteStream, status, error, cleanup } = useWebRTC(signaling);

  const handleJoin = useCallback(
    (key) => {
      setSessionKey(key);
      signaling.connect(key, genClientId());
    },
    [signaling],
  );

  const handleHangUp = useCallback(() => {
    cleanup();
    signaling.disconnect();
    setSessionKey(null);
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
    return <Lobby onJoin={handleJoin} />;
  }

  return (
    <Call
      sessionKey={sessionKey}
      localStream={localStream}
      remoteStream={remoteStream}
      status={status}
      onHangUp={handleHangUp}
    />
  );
}

import { useState, useRef, useEffect, useCallback } from "react";
import { useSignaling } from "./useSignaling";
import { useWebRTC } from "./useWebRTC";
import { QualityIndicator } from "./QualityIndicator";
import {
  IconVideo, IconVideoOff, IconMic, IconMicOff,
  IconScreenShare, IconScreenShareActive, IconHangUp,
  IconVolumeHigh, IconVolumeLow, IconVolumeMute,
  IconLink, IconCheck, IconSun, IconMoon, IconBridge, IconUser,
  IconEye, IconEyeOff, IconResize,
} from "./Icons";
import {
  NOISE_SUPPRESSION_STORAGE_KEY,
  applyAudioProcessingConstraints,
  getStoredNoiseSuppressionEnabled,
} from "./lib/media";
import "./App.css";

const getClientId = () => {
  let id = sessionStorage.getItem("vb-client-id");
  if (!id) {
    id = crypto.randomUUID().slice(0, 8);
    sessionStorage.setItem("vb-client-id", id);
  }
  return id;
};
const buildInviteLink = (key) => `${window.location.origin}?session=${key}`;
const getSessionFromUrl = () => new URLSearchParams(window.location.search).get("session");
const copyToClipboard = async (text) => {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
};

/* ── Тема ─────────────────────────────────────────────────────────── */

function useTheme() {
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem("vb-theme");
    if (saved) return saved;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("vb-theme", theme);
  }, [theme]);
  const toggle = useCallback(() => setTheme(p => p === "dark" ? "light" : "dark"), []);
  return { theme, toggle };
}

/* ── Видео-компонент (для remote) ─────────────────────────────────── */

function Video({ stream, muted = false, volume = 1, className = "" }) {
  const videoRef = useRef(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (!stream) { el.srcObject = null; return; }
    if (el.srcObject !== stream) el.srcObject = stream;
    el.play().catch(() => { el.muted = true; el.play().catch(() => {}); });
    return () => { el.srcObject = null; };
  }, [stream]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = muted;
    if (!muted) el.volume = volume;
  }, [muted, volume]);

  return (
    <div className={className}>
      <video ref={videoRef} playsInline autoPlay muted={muted} />
    </div>
  );
}

/* ── PiP с ресайзом ──────────────────────────────────────────────── */

function ResizablePip({ stream, visible }) {
  const wrapperRef = useRef(null);
  const pipVideoRef = useRef(null);
  const videoRef = useRef(null);
  const dragging = useRef(false);
  const startData = useRef(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (!stream) { el.srcObject = null; return; }
    if (el.srcObject !== stream) el.srcObject = stream;
    el.play().catch(() => { el.muted = true; el.play().catch(() => {}); });

    const updateAspect = () => {
      const pipDiv = pipVideoRef.current;
      if (pipDiv && el.videoWidth && el.videoHeight) {
        pipDiv.style.aspectRatio = `${el.videoWidth} / ${el.videoHeight}`;
      }
    };
    el.addEventListener("resize", updateAspect);
    el.addEventListener("loadedmetadata", updateAspect);
    return () => {
      el.removeEventListener("resize", updateAspect);
      el.removeEventListener("loadedmetadata", updateAspect);
      el.srcObject = null;
    };
  }, [stream]);

  const onPointerDown = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const w = wrapperRef.current;
    if (!w) return;
    dragging.current = true;
    startData.current = { x: e.clientX, w: w.offsetWidth };
    w.classList.add("pip-resizing");
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  }, []);

  const onPointerMove = useCallback((e) => {
    if (!dragging.current || !startData.current) return;
    const w = wrapperRef.current;
    if (!w) return;
    const dx = startData.current.x - e.clientX;
    const maxW = Math.min(400, window.innerWidth * 0.6);
    const newW = Math.max(80, Math.min(maxW, startData.current.w + dx));
    w.style.width = `${newW}px`;
  }, []);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
    startData.current = null;
    wrapperRef.current?.classList.remove("pip-resizing");
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
  }, [onPointerMove]);

  return (
    <div
      className={`pip-wrapper ${visible ? "" : "pip-hidden"}`}
      ref={wrapperRef}
    >
      <div className="pip-video" ref={pipVideoRef}>
        <video ref={videoRef} playsInline autoPlay muted />
      </div>
      <div
        className="pip-resize-handle"
        onPointerDown={onPointerDown}
      >
        <IconResize />
      </div>
    </div>
  );
}

/* ── Лобби ────────────────────────────────────────────────────────── */

function Lobby({ onJoin, initialKey, theme, onToggleTheme }) {
  const [key, setKey] = useState(initialKey || "");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const joinedRef = useRef(false);

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
      if (res.status === 429) {
        setErrorMsg("Слишком много попыток. Попробуйте через минуту.");
        return;
      }
      const data = await res.json();
      if (data.error) { setErrorMsg(data.message); return; }
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
      <button className="theme-toggle" onClick={onToggleTheme} title="Сменить тему">
        {theme === "dark" ? <IconSun /> : <IconMoon />}
      </button>
      <div className="lobby-logo">
        <IconBridge />
        <h1>Video Bridge</h1>
      </div>
      <p className="subtitle">Приватный видеомост для двоих</p>
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

/* ── Панель управления ────────────────────────────────────────────── */
/* camOn/micOn приходят из родителя (useWebRTC.localMediaState),
   onCameraToggle/onMicToggle — сеттеры, которые меняют track.enabled
   и шлют media-state пиру. */

function MediaControls({
  camOn, micOn, onCameraToggle, onMicToggle,
  noiseSuppressionEnabled, onNoiseSuppressionToggle,
  volume, onVolumeChange, onHangUp,
  isScreenSharing, onStartScreen, onStopScreen,
  pipVisible, onTogglePip,
}) {
  const VolumeIcon = volume === 0 ? IconVolumeMute : volume < 0.5 ? IconVolumeLow : IconVolumeHigh;

  return (
    <div className="controls-bar">
      <button
        className={`ctrl-btn ${micOn ? "" : "ctrl-off"}`}
        onClick={() => onMicToggle(!micOn)}
        title={micOn ? "Выключить микрофон" : "Включить микрофон"}
      >
        {micOn ? <IconMic /> : <IconMicOff />}
      </button>

      <button
        className={`ctrl-btn ${noiseSuppressionEnabled ? "ctrl-active" : ""}`}
        onClick={() => onNoiseSuppressionToggle(!noiseSuppressionEnabled)}
        title={noiseSuppressionEnabled ? "Отключить шумоподавление" : "Включить шумоподавление"}
      >
        <span className="ctrl-btn-label">NS</span>
      </button>

      <button
        className={`ctrl-btn ${camOn ? "" : "ctrl-off"}`}
        onClick={() => onCameraToggle(!camOn)}
        title={camOn ? "Выключить камеру" : "Включить камеру"}
      >
        {camOn ? <IconVideo /> : <IconVideoOff />}
      </button>

      <button
        className={`ctrl-btn ctrl-btn-screen ${isScreenSharing ? "ctrl-active" : ""}`}
        onClick={isScreenSharing ? onStopScreen : onStartScreen}
        title={isScreenSharing ? "Остановить демонстрацию" : "Демонстрация экрана"}
      >
        {isScreenSharing ? <IconScreenShareActive /> : <IconScreenShare />}
      </button>

      <button
        className={`ctrl-btn ${pipVisible ? "" : "ctrl-off"}`}
        onClick={onTogglePip}
        title={pipVisible ? "Скрыть своё видео" : "Показать своё видео"}
      >
        {pipVisible ? <IconEye /> : <IconEyeOff />}
      </button>

      <div className="volume-control">
        <span className="volume-icon"><VolumeIcon /></span>
        <input
          type="range" min="0" max="1" step="0.05"
          value={volume}
          onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
        />
      </div>

      <button className="ctrl-btn ctrl-hangup" onClick={onHangUp} title="Завершить">
        <IconHangUp />
      </button>
    </div>
  );
}

/* ── Видеозвонок ──────────────────────────────────────────────────── */

const STATUS_TEXT = {
  idle: "",
  waiting: "Ожидание собеседника…",
  connecting: "Соединение…",
  connected: "",
  reconnecting: "Переподключение…",
  disconnected: "Собеседник отключился",
};

function Call({
  sessionKey, localStream, remoteStream, status, onHangUp,
  isScreenSharing, onStartScreen, onStopScreen,
  theme, onToggleTheme,
  localMediaState, remoteMediaState,
  onCameraToggle, onMicToggle,
  noiseSuppressionEnabled, onNoiseSuppressionToggle,
  connectionQuality,
}) {
  const [peerVolume, setPeerVolume] = useState(1);
  const [copied, setCopied] = useState(false);
  const [pipVisible, setPipVisible] = useState(true);
  const statusMsg = STATUS_TEXT[status] ?? "";

  const handleCopyLink = async () => {
    const ok = await copyToClipboard(buildInviteLink(sessionKey));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Камера пира выключена → placeholder вместо последнего кадра
  const showRemotePlaceholder =
    !remoteStream || !remoteMediaState?.camera;

  return (
    <div className="call">
      {showRemotePlaceholder ? (
        <div className="remote-video remote-placeholder">
          <IconUser />
        </div>
      ) : (
        <Video stream={remoteStream} volume={peerVolume} className="remote-video" />
      )}

      {/* Аудио идёт всегда (если remoteStream есть), даже когда показан placeholder.
          Скрытый <audio> играет remote-стрим вне зависимости от <video>. */}
      {showRemotePlaceholder && remoteStream && (
        <RemoteAudio stream={remoteStream} volume={peerVolume} />
      )}

      {localStream && (
        <ResizablePip stream={localStream} visible={pipVisible} />
      )}

      {statusMsg && (
        <div className={`status-overlay status-${status}`}>{statusMsg}</div>
      )}

      <div className="top-bar">
        <div className="top-bar-left">
          <span className="session-badge">{sessionKey}</span>
          <button className="top-action-btn" onClick={handleCopyLink}>
            {copied ? <><IconCheck /> Скопировано</> : <><IconLink /> Ссылка</>}
          </button>
          {connectionQuality && status === "connected" && (
            <QualityIndicator
              rtt={connectionQuality.rtt}
              level={connectionQuality.level}
              relayed={connectionQuality.relayed}
            />
          )}
        </div>
        <div className="top-bar-right">
          <button className="theme-toggle-call" onClick={onToggleTheme} title="Сменить тему">
            {theme === "dark" ? <IconSun /> : <IconMoon />}
          </button>
        </div>
      </div>

      <MediaControls
        camOn={localMediaState?.camera ?? true}
        micOn={localMediaState?.mic ?? true}
        onCameraToggle={onCameraToggle}
        onMicToggle={onMicToggle}
        noiseSuppressionEnabled={noiseSuppressionEnabled}
        onNoiseSuppressionToggle={onNoiseSuppressionToggle}
        volume={peerVolume}
        onVolumeChange={setPeerVolume}
        onHangUp={onHangUp}
        isScreenSharing={isScreenSharing}
        onStartScreen={onStartScreen}
        onStopScreen={onStopScreen}
        pipVisible={pipVisible}
        onTogglePip={() => setPipVisible(v => !v)}
      />
    </div>
  );
}

/* Скрытый аудио-элемент: проигрывает remote audio,
   когда основной <video> не отрендерен (камера пира выключена). */
function RemoteAudio({ stream, volume }) {
  const audioRef = useRef(null);
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !stream) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    el.play().catch(() => {});
    return () => { el.srcObject = null; };
  }, [stream]);
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);
  return <audio ref={audioRef} autoPlay style={{ display: "none" }} />;
}

/* ── Корневой компонент ───────────────────────────────────────────── */

export default function App() {
  const [sessionKey, setSessionKey] = useState(null);
  const [, setIsCreator] = useState(false);
  const [noiseSuppressionEnabled, setNoiseSuppressionEnabled] = useState(getStoredNoiseSuppressionEnabled);
  const { theme, toggle: toggleTheme } = useTheme();
  const signaling = useSignaling();
  const {
    localStream, remoteStream, status, error, cleanup,
    isScreenSharing, startScreenShare, stopScreenShare,
    localMediaState, remoteMediaState,
    setLocalCameraEnabled, setLocalMicEnabled,
    connectionQuality,
  } = useWebRTC(signaling);

  const urlSessionKey = getSessionFromUrl();

  const handleNoiseSuppressionToggle = useCallback(
    async (enabled) => {
      setNoiseSuppressionEnabled(enabled);
      localStorage.setItem(NOISE_SUPPRESSION_STORAGE_KEY, enabled ? "on" : "off");
      await applyAudioProcessingConstraints(localStream, enabled);
    },
    [localStream],
  );

  const handleJoin = useCallback(
    (key, creator = false) => {
      setSessionKey(key);
      setIsCreator(creator);
      const url = new URL(window.location.href);
      url.searchParams.set("session", key);
      window.history.replaceState(null, "", url.toString());
      signaling.connect(key, getClientId());
    },
    [signaling],
  );

  const handleHangUp = useCallback(() => {
    signaling.send({ type: "hangup" });
    cleanup();
    signaling.disconnect();
    setSessionKey(null);
    setIsCreator(false);
    sessionStorage.removeItem("vb-client-id");
    const url = new URL(window.location.href);
    url.searchParams.delete("session");
    window.history.replaceState(null, "", url.pathname);
  }, [cleanup, signaling]);

  if (error) {
    return (
      <div className="lobby">
        <h2>Ошибка</h2>
        <p className="subtitle">{error}</p>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>
          Перезагрузить
        </button>
      </div>
    );
  }

  if (!sessionKey) {
    return <Lobby onJoin={handleJoin} initialKey={urlSessionKey} theme={theme} onToggleTheme={toggleTheme} />;
  }

  return (
    <Call
      sessionKey={sessionKey}
      localStream={localStream}
      remoteStream={remoteStream}
      status={status}
      onHangUp={handleHangUp}
      isScreenSharing={isScreenSharing}
      onStartScreen={startScreenShare}
      onStopScreen={stopScreenShare}
      theme={theme}
      onToggleTheme={toggleTheme}
      localMediaState={localMediaState}
      remoteMediaState={remoteMediaState}
      onCameraToggle={setLocalCameraEnabled}
      onMicToggle={setLocalMicEnabled}
      noiseSuppressionEnabled={noiseSuppressionEnabled}
      onNoiseSuppressionToggle={handleNoiseSuppressionToggle}
      connectionQuality={connectionQuality}
    />
  );
}

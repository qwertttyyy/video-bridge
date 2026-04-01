// frontend/src/useWebRTC.js
import { useRef, useState, useCallback, useEffect } from "react";

/**
 * WebRTC с «Perfect Negotiation» паттерном.
 *
 * Ключевые улучшения:
 * — Perfect Negotiation: caller = impolite, callee = polite → нет коллизий offer/offer
 * — negotiationneeded обрабатывается автоматически (screen share, addTrack)
 * — Камера хранится отдельно от «отображаемого» стрима
 * — Remote stream пересоздаётся при реконнекте (не копит старые треки)
 * — Таймаут на подключение
 * — ICE restart с корректным сбросом очереди
 */

const ICE_RESTART_DELAY = 2500;
const CONNECTION_TIMEOUT = 15000; // 15 секунд на установку соединения

export function useWebRTC({ send, setOnMessage }) {
  const pcRef = useRef(null);
  const cameraStreamRef = useRef(null);     // Оригинальный стрим камеры (не меняется)
  const screenStreamRef = useRef(null);
  const roleRef = useRef(null);             // "caller" | "callee"
  const makingOfferRef = useRef(false);     // Флаг: мы сейчас создаём offer
  const ignoreOfferRef = useRef(false);     // Флаг: игнорировать входящий offer (impolite peer)
  const restartTimerRef = useRef(null);
  const connectionTimerRef = useRef(null);
  const iceConfigRef = useRef(null);

  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  /** Polite peer уступает при коллизии, impolite — нет */
  const isPolite = useCallback(() => roleRef.current === "callee", []);

  /* ── Загрузка ICE конфигурации ── */

  const getIceConfig = useCallback(async () => {
    if (iceConfigRef.current) return iceConfigRef.current;
    const res = await fetch("/api/ice-config");
    const config = await res.json();
    iceConfigRef.current = config;
    return config;
  }, []);

  /* ── Таймаут подключения ── */

  const startConnectionTimeout = useCallback(() => {
    clearTimeout(connectionTimerRef.current);
    connectionTimerRef.current = setTimeout(() => {
      const pc = pcRef.current;
      if (!pc) return;
      const state = pc.iceConnectionState;
      if (state !== "connected" && state !== "completed") {
        console.warn("[WebRTC] Таймаут подключения, пробую ICE restart");
        scheduleIceRestart();
      }
    }, CONNECTION_TIMEOUT);
  }, []);

  const clearConnectionTimeout = useCallback(() => {
    clearTimeout(connectionTimerRef.current);
    connectionTimerRef.current = null;
  }, []);

  /* ── Медиа ── */

  const acquireMedia = useCallback(async () => {
    if (cameraStreamRef.current) return cameraStreamRef.current;
    console.log("[WebRTC] Запрашиваю getUserMedia...");
    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch {
        // Фоллбэк на базовые constraints
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      }
      console.log("[WebRTC] getUserMedia OK, треки:",
        stream.getTracks().map(t => `${t.kind}=${t.readyState}`).join(", "));
      cameraStreamRef.current = stream;
      setLocalStream(stream);
      return stream;
    } catch (err) {
      console.error("[WebRTC] getUserMedia FAIL:", err.name, err.message);
      throw err;
    }
  }, []);

  /* ── ICE Restart ── */

  const scheduleIceRestart = useCallback(() => {
    if (restartTimerRef.current) return;
    const pc = pcRef.current;
    if (!pc || pc.signalingState === "closed") return;

    console.log(`[WebRTC] ICE restart через ${ICE_RESTART_DELAY}мс`);
    setStatus("reconnecting");

    restartTimerRef.current = setTimeout(async () => {
      restartTimerRef.current = null;
      const currentPc = pcRef.current;
      if (!currentPc || currentPc.signalingState === "closed") return;

      try {
        const offer = await currentPc.createOffer({ iceRestart: true });
        if (currentPc.signalingState === "closed") return;
        await currentPc.setLocalDescription(offer);
        send({ type: "offer", sdp: currentPc.localDescription });
        startConnectionTimeout();
      } catch (err) {
        console.error("[WebRTC] ICE restart failed:", err);
      }
    }, ICE_RESTART_DELAY);
  }, [send, startConnectionTimeout]);

  /* ── PeerConnection ── */

  const closePc = useCallback(() => {
    clearTimeout(restartTimerRef.current);
    restartTimerRef.current = null;
    clearConnectionTimeout();

    screenStreamRef.current?.getTracks().forEach(t => t.stop());
    screenStreamRef.current = null;
    setIsScreenSharing(false);

    makingOfferRef.current = false;
    ignoreOfferRef.current = false;

    pcRef.current?.close();
    pcRef.current = null;
  }, [clearConnectionTimeout]);

  const createPC = useCallback(async () => {
    closePc();

    const config = await getIceConfig();
    const pc = new RTCPeerConnection({ iceServers: config.iceServers });
    pcRef.current = pc;

    // Свежий remote stream — не накапливает треки от предыдущих подключений
    const remote = new MediaStream();
    setRemoteStream(remote);

    pc.ontrack = (e) => {
      console.log("[WebRTC] ontrack:", e.track.kind, e.track.id);
      // Удаляем старые треки того же kind, чтобы не дублировать
      remote.getTracks()
        .filter(t => t.kind === e.track.kind)
        .forEach(t => remote.removeTrack(t));
      remote.addTrack(e.track);

      e.track.onended = () => {
        remote.removeTrack(e.track);
      };
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        send({ type: "ice-candidate", candidate: e.candidate });
      }
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      console.log("[WebRTC] ICE state:", s);

      if (s === "connected" || s === "completed") {
        clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
        clearConnectionTimeout();
        setStatus("connected");
      }
      if (s === "disconnected") {
        // disconnected может быть временным — ждём перед restart
        setStatus("reconnecting");
        scheduleIceRestart();
      }
      if (s === "failed") {
        setStatus("reconnecting");
        scheduleIceRestart();
      }
    };

    /**
     * Perfect Negotiation: negotiationneeded → создаём offer.
     * Если мы polite и получили чужой offer во время создания своего →
     * откатываемся и принимаем чужой (rollback).
     */
    pc.onnegotiationneeded = async () => {
      try {
        makingOfferRef.current = true;
        await pc.setLocalDescription();
        send({ type: "offer", sdp: pc.localDescription });
        startConnectionTimeout();
      } catch (err) {
        console.error("[WebRTC] negotiationneeded error:", err);
      } finally {
        makingOfferRef.current = false;
      }
    };

    return pc;
  }, [send, closePc, getIceConfig, scheduleIceRestart, startConnectionTimeout, clearConnectionTimeout]);

  /* ── Демонстрация экрана ── */

  const startScreenShare = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc) return;

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      screenStreamRef.current = screenStream;

      const screenVideoTrack = screenStream.getVideoTracks()[0];

      // Заменяем видеотрек через replaceTrack (без ренегоциации)
      const videoSender = pc.getSenders().find(s => s.track?.kind === "video");
      if (videoSender && screenVideoTrack) {
        await videoSender.replaceTrack(screenVideoTrack);
      }

      // Обновляем отображаемый стрим для PiP
      const displayStream = new MediaStream([
        screenVideoTrack,
        ...(cameraStreamRef.current?.getAudioTracks() || []),
      ]);
      setLocalStream(displayStream);
      setIsScreenSharing(true);

      // Когда пользователь жмёт «Остановить» в браузере
      screenVideoTrack.onended = () => {
        doStopScreenShare();
      };

      console.log("[WebRTC] Демонстрация экрана запущена");
    } catch (err) {
      if (err.name !== "NotAllowedError") {
        console.error("[WebRTC] getDisplayMedia FAIL:", err);
      }
    }
  }, []);

  const doStopScreenShare = useCallback(async () => {
    const pc = pcRef.current;
    const cameraStream = cameraStreamRef.current;

    if (!pc || !cameraStream) return;

    // Останавливаем треки экрана
    screenStreamRef.current?.getTracks().forEach(t => t.stop());
    screenStreamRef.current = null;

    // Возвращаем камеру
    const cameraVideoTrack = cameraStream.getVideoTracks()[0];
    if (cameraVideoTrack) {
      const videoSender = pc.getSenders().find(s => s.track?.kind === "video");
      if (videoSender) {
        await videoSender.replaceTrack(cameraVideoTrack);
      }
    }

    setLocalStream(cameraStream);
    setIsScreenSharing(false);
    console.log("[WebRTC] Демонстрация экрана остановлена");
  }, []);

  /* ── Сигналинг: Perfect Negotiation ── */

  const handleOffer = useCallback(async (sdp) => {
    const pc = pcRef.current;
    if (!pc) return;

    // Коллизия: мы тоже делаем offer прямо сейчас
    const offerCollision = makingOfferRef.current || pc.signalingState !== "stable";

    // Impolite peer игнорирует чужой offer при коллизии
    ignoreOfferRef.current = !isPolite() && offerCollision;
    if (ignoreOfferRef.current) {
      console.log("[WebRTC] Игнорирую встречный offer (impolite, коллизия)");
      return;
    }

    // Polite peer: rollback своего offer
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ type: "answer", sdp: pc.localDescription });
  }, [send, isPolite]);

  const handleAnswer = useCallback(async (sdp) => {
    const pc = pcRef.current;
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    } catch (err) {
      // Может прийти answer на уже откаченный offer — не критично
      console.warn("[WebRTC] setRemoteDescription(answer) error:", err.message);
    }
  }, []);

  const handleIceCandidate = useCallback(async (candidate) => {
    const pc = pcRef.current;
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      // Кандидат для устаревшего offer — игнорируем
      if (!ignoreOfferRef.current) {
        console.warn("[WebRTC] addIceCandidate error:", err.message);
      }
    }
  }, []);

  const initPeerConnection = useCallback(async () => {
    setStatus("connecting");
    const stream = await acquireMedia();
    const pc = await createPC();
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    // negotiationneeded сработает автоматически → offer создастся сам
  }, [acquireMedia, createPC]);

  const cleanup = useCallback(() => {
    closePc();
    cameraStreamRef.current?.getTracks().forEach(t => t.stop());
    cameraStreamRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setStatus("idle");
    setError(null);
    iceConfigRef.current = null;
  }, [closePc]);

  /* ── Подписка WS ── */

  useEffect(() => {
    const processMessage = async (data) => {
      try {
        console.log("[WS ←]", data.type, data.role || "");
        switch (data.type) {
          case "role":
            roleRef.current = data.role;
            await acquireMedia();
            setStatus(data.role === "caller" ? "waiting" : "idle");
            break;

          case "peer_joined":
            // Мы — caller, собеседник подключился → создаём PeerConnection
            await initPeerConnection();
            break;

          case "offer":
            // Если PC ещё нет (мы callee, первый offer) → создаём
            if (!pcRef.current || pcRef.current.signalingState === "closed") {
              setStatus("connecting");
              const stream = await acquireMedia();
              const pc = await createPC();
              stream.getTracks().forEach(t => pc.addTrack(t, stream));
              // Не ждём negotiationneeded — сразу обрабатываем offer
            }
            await handleOffer(data.sdp);
            break;

          case "answer":
            await handleAnswer(data.sdp);
            break;

          case "ice-candidate":
            await handleIceCandidate(data.candidate);
            break;

          case "peer_disconnected":
            closePc();
            setRemoteStream(null);
            setStatus("disconnected");
            break;
        }
      } catch (err) {
        console.error("[WebRTC] Ошибка обработки сообщения:", err);
        setError(err.message);
      }
    };

    setOnMessage(processMessage);
  }, [
    setOnMessage, acquireMedia, createPC, initPeerConnection,
    handleOffer, handleAnswer, handleIceCandidate, closePc,
  ]);

  useEffect(() => cleanup, [cleanup]);

  return {
    localStream, remoteStream, status, error, cleanup,
    isScreenSharing, startScreenShare, stopScreenShare: doStopScreenShare,
  };
}
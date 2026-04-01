import { useRef, useState, useCallback, useEffect } from "react";

/**
 * WebRTC с «Perfect Negotiation» и оптимизацией задержки.
 *
 * — Caller: addTrack → negotiationneeded → offer (автоматически)
 * — Callee: первый offer обрабатывается явно (negotiationneeded подавляется)
 * — Ренегоциация (screen share, ICE restart): negotiationneeded штатно
 * — Latency: iceCandidatePoolSize, codec preferences, jitterBufferTarget
 */

// ── Настраиваемые константы ──────────────────────────────────────────
const ICE_RESTART_DELAY = 2500;
const CONNECTION_TIMEOUT = 5000;    // Таймаут на установку соединения (мс)
const CANDIDATE_POOL_SIZE = 4;      // Пре-сбор ICE-кандидатов
const JITTER_BUFFER_MS = 50;        // Целевой jitter buffer (мс)
const MAX_VIDEO_BITRATE = 2_500_000; // Макс. битрейт видео (bps)
// ─────────────────────────────────────────────────────────────────────

export function useWebRTC({ send, setOnMessage }) {
  const pcRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const roleRef = useRef(null);
  const makingOfferRef = useRef(false);
  const ignoreOfferRef = useRef(false);
  const suppressNegotiationRef = useRef(false);
  const restartTimerRef = useRef(null);
  const connectionTimerRef = useRef(null);
  const iceConfigRef = useRef(null);

  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  const isPolite = useCallback(() => roleRef.current === "callee", []);

  /* ── ICE конфигурация ── */

  const getIceConfig = useCallback(async () => {
    if (iceConfigRef.current) return iceConfigRef.current;
    const res = await fetch("/api/ice-config");
    const config = await res.json();
    iceConfigRef.current = config;
    return config;
  }, []);

  /* ── Таймаут подключения ── */

  const clearConnectionTimeout = useCallback(() => {
    clearTimeout(connectionTimerRef.current);
    connectionTimerRef.current = null;
  }, []);

  const scheduleIceRestartRef = useRef(null);

  const startConnectionTimeout = useCallback(() => {
    clearConnectionTimeout();
    connectionTimerRef.current = setTimeout(() => {
      const pc = pcRef.current;
      if (!pc) return;
      const s = pc.iceConnectionState;
      if (s !== "connected" && s !== "completed") {
        console.warn(`[WebRTC] Таймаут ${CONNECTION_TIMEOUT}мс — ICE restart`);
        scheduleIceRestartRef.current?.();
      }
    }, CONNECTION_TIMEOUT);
  }, [clearConnectionTimeout]);

  /* ── Медиа ── */

  const acquireMedia = useCallback(async () => {
    if (cameraStreamRef.current) return cameraStreamRef.current;
    console.log("[WebRTC] getUserMedia...");
    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      }
      console.log("[WebRTC] getUserMedia OK:", stream.getTracks().map(t => t.kind).join(", "));
      cameraStreamRef.current = stream;
      setLocalStream(stream);
      return stream;
    } catch (err) {
      console.error("[WebRTC] getUserMedia FAIL:", err.name, err.message);
      throw err;
    }
  }, []);

  /* ── Оптимизация задержки ── */

  const preferLowLatencyCodecs = useCallback((pc) => {
    if (!pc.getTransceivers) return;
    for (const tr of pc.getTransceivers()) {
      if (tr.receiver.track?.kind !== "video") continue;
      if (!tr.setCodecPreferences) continue;
      try {
        const codecs = RTCRtpReceiver.getCapabilities("video")?.codecs || [];
        const sorted = [
          ...codecs.filter(c => c.mimeType === "video/VP8"),
          ...codecs.filter(c => c.mimeType === "video/H264"),
          ...codecs.filter(c => c.mimeType !== "video/VP8" && c.mimeType !== "video/H264"),
        ];
        tr.setCodecPreferences(sorted);
      } catch { /* не все браузеры поддерживают */ }
    }
  }, []);

  const tuneReceiverLatency = useCallback((pc) => {
    for (const r of pc.getReceivers()) {
      if (typeof r.jitterBufferTarget !== "undefined") {
        r.jitterBufferTarget = JITTER_BUFFER_MS / 1000;
      }
      if (typeof r.playoutDelayHint !== "undefined") {
        r.playoutDelayHint = 0;
      }
    }
  }, []);

  const tuneSenderParams = useCallback(async (pc) => {
    for (const sender of pc.getSenders()) {
      if (!sender.track) continue;
      const params = sender.getParameters();
      if (!params.encodings?.length) continue;
      for (const enc of params.encodings) {
        if (sender.track.kind === "video") {
          enc.maxBitrate = MAX_VIDEO_BITRATE;
          enc.degradationPreference = "maintain-framerate";
        }
      }
      try { await sender.setParameters(params); } catch { /* ok */ }
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

  scheduleIceRestartRef.current = scheduleIceRestart;

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
    suppressNegotiationRef.current = false;
    pcRef.current?.close();
    pcRef.current = null;
  }, [clearConnectionTimeout]);

  const createPC = useCallback(async () => {
    closePc();
    const config = await getIceConfig();

    const pc = new RTCPeerConnection({
      iceServers: config.iceServers,
      iceCandidatePoolSize: CANDIDATE_POOL_SIZE,
      bundlePolicy: "max-bundle",
    });
    pcRef.current = pc;

    const remote = new MediaStream();
    setRemoteStream(remote);

    pc.ontrack = (e) => {
      console.log("[WebRTC] ontrack:", e.track.kind, e.track.id);
      remote.getTracks().filter(t => t.kind === e.track.kind).forEach(t => remote.removeTrack(t));
      remote.addTrack(e.track);
      e.track.onended = () => remote.removeTrack(e.track);
      tuneReceiverLatency(pc);
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) send({ type: "ice-candidate", candidate: e.candidate });
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      console.log("[WebRTC] ICE state:", s);
      if (s === "connected" || s === "completed") {
        clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
        clearConnectionTimeout();
        setStatus("connected");
        tuneSenderParams(pc);
        tuneReceiverLatency(pc);
      }
      if (s === "disconnected" || s === "failed") {
        setStatus("reconnecting");
        scheduleIceRestart();
      }
    };

    // Perfect Negotiation: negotiationneeded
    pc.onnegotiationneeded = async () => {
      if (suppressNegotiationRef.current) {
        console.log("[WebRTC] negotiationneeded подавлен (setup callee)");
        return;
      }
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
  }, [
    send, closePc, getIceConfig, scheduleIceRestart,
    startConnectionTimeout, clearConnectionTimeout,
    tuneSenderParams, tuneReceiverLatency,
  ]);

  /* ── Демонстрация экрана ── */

  const startScreenShare = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc) return;
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      screenStreamRef.current = screenStream;
      const screenVideoTrack = screenStream.getVideoTracks()[0];

      const videoSender = pc.getSenders().find(s => s.track?.kind === "video");
      if (videoSender && screenVideoTrack) await videoSender.replaceTrack(screenVideoTrack);

      const displayStream = new MediaStream([
        screenVideoTrack,
        ...(cameraStreamRef.current?.getAudioTracks() || []),
      ]);
      setLocalStream(displayStream);
      setIsScreenSharing(true);
      screenVideoTrack.onended = () => doStopScreenShare();
      console.log("[WebRTC] Демонстрация экрана запущена");
    } catch (err) {
      if (err.name !== "NotAllowedError") console.error("[WebRTC] getDisplayMedia FAIL:", err);
    }
  }, []);

  const doStopScreenShare = useCallback(async () => {
    const pc = pcRef.current;
    const cam = cameraStreamRef.current;
    if (!pc || !cam) return;
    screenStreamRef.current?.getTracks().forEach(t => t.stop());
    screenStreamRef.current = null;
    const camVideo = cam.getVideoTracks()[0];
    if (camVideo) {
      const videoSender = pc.getSenders().find(s => s.track?.kind === "video");
      if (videoSender) await videoSender.replaceTrack(camVideo);
    }
    setLocalStream(cam);
    setIsScreenSharing(false);
    console.log("[WebRTC] Демонстрация экрана остановлена");
  }, []);

  /* ── Сигналинг: два явных сценария для первого подключения ── */

  /** Caller: создаёт PC → addTrack → negotiationneeded → offer автоматически */
  const initAsCallerAndOffer = useCallback(async () => {
    setStatus("connecting");
    const stream = await acquireMedia();
    const pc = await createPC();
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    preferLowLatencyCodecs(pc);
  }, [acquireMedia, createPC, preferLowLatencyCodecs]);

  /** Callee: создаёт PC с подавленным negotiationneeded, явно answer-ит */
  const initAsCalleeAndAnswer = useCallback(async (sdp) => {
    setStatus("connecting");
    const stream = await acquireMedia();

    suppressNegotiationRef.current = true;
    const pc = await createPC();
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    preferLowLatencyCodecs(pc);

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ type: "answer", sdp: pc.localDescription });

    suppressNegotiationRef.current = false;
    startConnectionTimeout();
  }, [acquireMedia, createPC, preferLowLatencyCodecs, send, startConnectionTimeout]);

  /** Ренегоциация: PC уже есть — Perfect Negotiation */
  const handleOffer = useCallback(async (sdp) => {
    const pc = pcRef.current;
    if (!pc) return;
    const offerCollision = makingOfferRef.current || pc.signalingState !== "stable";
    ignoreOfferRef.current = !isPolite() && offerCollision;
    if (ignoreOfferRef.current) {
      console.log("[WebRTC] Игнорирую offer (impolite, коллизия)");
      return;
    }
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
      console.warn("[WebRTC] setRemoteDescription(answer):", err.message);
    }
  }, []);

  const handleIceCandidate = useCallback(async (candidate) => {
    const pc = pcRef.current;
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      if (!ignoreOfferRef.current) {
        console.warn("[WebRTC] addIceCandidate:", err.message);
      }
    }
  }, []);

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
            await initAsCallerAndOffer();
            break;

          case "offer": {
            const pc = pcRef.current;
            if (!pc || pc.signalingState === "closed") {
              await initAsCalleeAndAnswer(data.sdp);
            } else {
              await handleOffer(data.sdp);
            }
            break;
          }

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
        console.error("[WebRTC] Ошибка обработки:", err);
        setError(err.message);
      }
    };
    setOnMessage(processMessage);
  }, [
    setOnMessage, acquireMedia, initAsCallerAndOffer, initAsCalleeAndAnswer,
    handleOffer, handleAnswer, handleIceCandidate, closePc,
  ]);

  useEffect(() => cleanup, [cleanup]);

  return {
    localStream, remoteStream, status, error, cleanup,
    isScreenSharing, startScreenShare, stopScreenShare: doStopScreenShare,
  };
}
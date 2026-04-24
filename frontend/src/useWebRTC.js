import { useRef, useState, useCallback, useEffect } from "react";

/**
 * WebRTC с Perfect Negotiation.
 *
 * Роли:
 *   polite   — при glare делает rollback и принимает чужой offer
 *   impolite — при glare игнорирует чужой offer, держит свой
 *
 * ICE restart — через pc.restartIce(), который сам запускает negotiationneeded.
 * Это устраняет цикл glare, бывший при ручном createOffer({iceRestart:true}).
 */

const CANDIDATE_POOL_SIZE = 4;
const JITTER_BUFFER_MS = 50;
const MAX_VIDEO_BITRATE = 2_500_000;

const ICE_DISCONNECTED_GRACE_MS = 5000;   // ждём само-восстановления
const PEER_DISCONNECTED_GRACE_MS = 8000;  // даём пиру время на реконнект WS

export function useWebRTC({ send, setOnMessage }) {
  const pcRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const politeRef = useRef(false);
  const makingOfferRef = useRef(false);
  const ignoreOfferRef = useRef(false);
  const suppressNegotiationRef = useRef(false);
  const iceConfigRef = useRef(null);
  const iceDisconnectTimerRef = useRef(null);
  const peerDisconnectTimerRef = useRef(null);
  const pendingCandidatesRef = useRef([]);

  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  /* ── ICE конфигурация ── */
  const getIceConfig = useCallback(async () => {
    if (iceConfigRef.current) return iceConfigRef.current;
    const res = await fetch("/api/ice-config");
    const config = await res.json();
    iceConfigRef.current = config;
    return config;
  }, []);

  /* ── Таймеры ── */
  const clearIceDisconnectTimer = () => {
    clearTimeout(iceDisconnectTimerRef.current);
    iceDisconnectTimerRef.current = null;
  };
  const clearPeerDisconnectTimer = () => {
    clearTimeout(peerDisconnectTimerRef.current);
    peerDisconnectTimerRef.current = null;
  };

  /* ── Медиа ── */
  const acquireMedia = useCallback(async () => {
    if (cameraStreamRef.current) return cameraStreamRef.current;
    console.log("[WebRTC] getUserMedia...");
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    }
    cameraStreamRef.current = stream;
    setLocalStream(stream);
    return stream;
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
      } catch { /* ok */ }
    }
  }, []);

  const tuneReceiverLatency = useCallback((pc) => {
    for (const r of pc.getReceivers()) {
      if (typeof r.jitterBufferTarget !== "undefined") r.jitterBufferTarget = JITTER_BUFFER_MS / 1000;
      if (typeof r.playoutDelayHint !== "undefined") r.playoutDelayHint = 0;
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

  /* ── Закрытие PC ── */
  const closePc = useCallback(() => {
    clearIceDisconnectTimer();
    screenStreamRef.current?.getTracks().forEach(t => t.stop());
    screenStreamRef.current = null;
    setIsScreenSharing(false);
    makingOfferRef.current = false;
    ignoreOfferRef.current = false;
    suppressNegotiationRef.current = false;
    pendingCandidatesRef.current = [];
    pcRef.current?.close();
    pcRef.current = null;
  }, []);

  /* ── Создание PC ── */
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
      console.log("[WebRTC] ontrack:", e.track.kind);
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
        clearIceDisconnectTimer();
        setStatus("connected");
        tuneSenderParams(pc);
        tuneReceiverLatency(pc);
        return;
      }

      if (s === "disconnected") {
        setStatus("reconnecting");
        // даём браузеру шанс восстановить без ICE restart
        clearIceDisconnectTimer();
        iceDisconnectTimerRef.current = setTimeout(() => {
          if (pcRef.current === pc && pc.iceConnectionState === "disconnected") {
            console.log("[WebRTC] disconnected затянулся → restartIce()");
            pc.restartIce();
          }
        }, ICE_DISCONNECTED_GRACE_MS);
        return;
      }

      if (s === "failed") {
        console.log("[WebRTC] ICE failed → restartIce()");
        setStatus("reconnecting");
        pc.restartIce();
      }
    };

    // Perfect Negotiation через штатный negotiationneeded
    pc.onnegotiationneeded = async () => {
      if (suppressNegotiationRef.current) {
        console.log("[WebRTC] negotiationneeded подавлен (начальный сетап callee)");
        return;
      }
      try {
        makingOfferRef.current = true;
        await pc.setLocalDescription();
        send({ type: "offer", sdp: pc.localDescription });
      } catch (err) {
        console.error("[WebRTC] negotiationneeded error:", err);
      } finally {
        makingOfferRef.current = false;
      }
    };

    return pc;
  }, [send, closePc, getIceConfig, tuneSenderParams, tuneReceiverLatency]);

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
  }, []);

  /* ── Начальный сетап ── */

  /** Роль инициатора: addTrack → negotiationneeded → offer автоматически */
  const initAsInitiatorAndOffer = useCallback(async () => {
    setStatus("connecting");
    const stream = await acquireMedia();
    const pc = await createPC();
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    preferLowLatencyCodecs(pc);
  }, [acquireMedia, createPC, preferLowLatencyCodecs]);

  /** Роль получателя первого offer — создаём PC и явно отвечаем answer */
  const initAsReceiverAndAnswer = useCallback(async (sdp) => {
    setStatus("connecting");
    const stream = await acquireMedia();

    suppressNegotiationRef.current = true;
    const pc = await createPC();
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    preferLowLatencyCodecs(pc);

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await pc.setLocalDescription();
    send({ type: "answer", sdp: pc.localDescription });

    suppressNegotiationRef.current = false;

    // буферизованные кандидаты
    for (const c of pendingCandidatesRef.current) {
      try { await pc.addIceCandidate(c); } catch { /* ok */ }
    }
    pendingCandidatesRef.current = [];
  }, [acquireMedia, createPC, preferLowLatencyCodecs, send]);

  /* ── Perfect Negotiation — обработка offer/answer/candidate ── */

  const handleOffer = useCallback(async (sdp) => {
    const pc = pcRef.current;
    if (!pc) return;
    const offerCollision = makingOfferRef.current || pc.signalingState !== "stable";
    ignoreOfferRef.current = !politeRef.current && offerCollision;
    if (ignoreOfferRef.current) {
      console.log("[WebRTC] Игнорирую offer (impolite, коллизия)");
      return;
    }
    // polite: setRemoteDescription сам откатит локальный offer (implicit rollback в Chrome/Firefox)
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await pc.setLocalDescription();
    send({ type: "answer", sdp: pc.localDescription });
  }, [send]);

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
    const ice = new RTCIceCandidate(candidate);
    if (!pc || !pc.remoteDescription) {
      // PC ещё не создан или remoteDescription не выставлен — буферизуем
      pendingCandidatesRef.current.push(ice);
      return;
    }
    try {
      await pc.addIceCandidate(ice);
    } catch (err) {
      if (!ignoreOfferRef.current) {
        console.warn("[WebRTC] addIceCandidate:", err.message);
      }
    }
  }, []);

  const cleanup = useCallback(() => {
    clearPeerDisconnectTimer();
    closePc();
    cameraStreamRef.current?.getTracks().forEach(t => t.stop());
    cameraStreamRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setStatus("idle");
    setError(null);
    iceConfigRef.current = null;
  }, [closePc]);

  /* ── Подписка на WS сообщения ── */
  useEffect(() => {
    const processMessage = async (data) => {
      try {
        console.log("[WS ←]", data.type, data.polite !== undefined ? `polite=${data.polite}` : "");
        switch (data.type) {
          case "role":
            if (typeof data.polite === "boolean") {
              politeRef.current = data.polite;
            }
            await acquireMedia();
            setStatus(data.polite === null ? "waiting" : "idle");
            break;

          case "peer_joined": {
            if (typeof data.polite === "boolean") {
              politeRef.current = data.polite;
            }
            clearPeerDisconnectTimer();

            const pc = pcRef.current;
            // Живой PC — пир вернулся после короткого разрыва, ничего не делаем
            if (pc && (pc.connectionState === "connected" || pc.connectionState === "connecting")) {
              console.log("[WebRTC] peer_joined при живом PC — пропускаю");
              break;
            }
            // Инициатором offer становится impolite (меньше шанс glare на старте)
            if (!politeRef.current) {
              await initAsInitiatorAndOffer();
            } else {
              // polite ждёт offer от impolite, но готовит медиа заранее
              await acquireMedia();
              setStatus("connecting");
            }
            break;
          }

          case "offer": {
            const pc = pcRef.current;
            if (!pc || pc.signalingState === "closed") {
              await initAsReceiverAndAnswer(data.sdp);
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
            // Grace period: возможно, пир просто моргнул WS и сейчас вернётся
            clearPeerDisconnectTimer();
            peerDisconnectTimerRef.current = setTimeout(() => {
              console.log("[WebRTC] peer не вернулся, закрываю PC");
              closePc();
              setRemoteStream(null);
              setStatus("disconnected");
            }, PEER_DISCONNECTED_GRACE_MS);
            setStatus("reconnecting");
            break;
        }
      } catch (err) {
        console.error("[WebRTC] Ошибка обработки:", err);
        setError(err.message);
      }
    };
    setOnMessage(processMessage);
  }, [
    setOnMessage, acquireMedia, initAsInitiatorAndOffer, initAsReceiverAndAnswer,
    handleOffer, handleAnswer, handleIceCandidate, closePc,
  ]);

  useEffect(() => cleanup, [cleanup]);

  return {
    localStream, remoteStream, status, error, cleanup,
    isScreenSharing, startScreenShare, stopScreenShare: doStopScreenShare,
  };
}
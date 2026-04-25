// frontend/src/useWebRTC.js
import { useRef, useState, useCallback, useEffect } from "react";
import { log, describeCandidate, describeSdp, logSelectedPair } from "./logger";

const CANDIDATE_POOL_SIZE = 4;
const JITTER_BUFFER_MS = 50;
const MAX_VIDEO_BITRATE = 2_500_000;

const ICE_DISCONNECTED_GRACE_MS = 5000;
const PEER_DISCONNECTED_GRACE_MS = 8000;
const STATS_INTERVAL_MS = 15000;

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
  const statsIntervalRef = useRef(null);
  const pendingCandidatesRef = useRef([]);

  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  const clearIceDisconnectTimer = () => {
    clearTimeout(iceDisconnectTimerRef.current);
    iceDisconnectTimerRef.current = null;
  };
  const clearPeerDisconnectTimer = () => {
    clearTimeout(peerDisconnectTimerRef.current);
    peerDisconnectTimerRef.current = null;
  };
  const clearStatsInterval = () => {
    clearInterval(statsIntervalRef.current);
    statsIntervalRef.current = null;
  };

  /* ── ICE конфиг ── */
  const getIceConfig = useCallback(async () => {
    if (iceConfigRef.current) return iceConfigRef.current;
    log.ice("fetch /api/ice-config");
    const res = await fetch("/api/ice-config");
    const config = await res.json();
    log.ice("iceServers:", config.iceServers.map(s => s.urls));
    iceConfigRef.current = config;
    return config;
  }, []);

  /* ── Медиа ── */
  const acquireMedia = useCallback(async () => {
    if (cameraStreamRef.current) {
      log.media("acquireMedia: stream уже получен");
      return cameraStreamRef.current;
    }
    log.media("getUserMedia начало");
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      log.warn("getUserMedia HD failed, пробую базовый:", err.name);
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    }
    log.media("getUserMedia OK:", stream.getTracks().map(t => `${t.kind}:${t.label}`));
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
    if (pcRef.current) {
      log.pc("closePc: state был", pcRef.current.connectionState);
    }
    clearIceDisconnectTimer();
    clearStatsInterval();
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

    log.pc("new RTCPeerConnection, polite=", politeRef.current);
    const pc = new RTCPeerConnection({
      iceServers: config.iceServers,
      iceCandidatePoolSize: CANDIDATE_POOL_SIZE,
      bundlePolicy: "max-bundle",
    });
    pcRef.current = pc;

    const remote = new MediaStream();
    setRemoteStream(remote);

    pc.ontrack = (e) => {
      log.media("ontrack:", e.track.kind, "id=", e.track.id);
      remote.getTracks().filter(t => t.kind === e.track.kind).forEach(t => remote.removeTrack(t));
      remote.addTrack(e.track);
      e.track.onended = () => {
        log.media("remote track ended:", e.track.kind);
        remote.removeTrack(e.track);
      };
      tuneReceiverLatency(pc);
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        log.ice("local candidate →", describeCandidate(e.candidate));
        send({ type: "ice-candidate", candidate: e.candidate });
      } else {
        log.ice("local gathering завершён");
      }
    };

    pc.onicegatheringstatechange = () => {
      log.ice("gatheringState →", pc.iceGatheringState);
    };

    pc.onsignalingstatechange = () => {
      log.neg("signalingState →", pc.signalingState);
    };

    pc.onconnectionstatechange = () => {
      log.pc("connectionState →", pc.connectionState);
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      log.ice("iceConnectionState →", s);

      if (s === "connected" || s === "completed") {
        clearIceDisconnectTimer();
        setStatus("connected");
        tuneSenderParams(pc);
        tuneReceiverLatency(pc);
        // итоговая пара через 500мс (дать время nomination)
        setTimeout(() => logSelectedPair(pc, "пара после connected"), 500);
        // периодический мониторинг качества
        clearStatsInterval();
        statsIntervalRef.current = setInterval(
          () => logSelectedPair(pc, "пара периодически"),
          STATS_INTERVAL_MS,
        );
        return;
      }

      if (s === "disconnected") {
        setStatus("reconnecting");
        clearIceDisconnectTimer();
        iceDisconnectTimerRef.current = setTimeout(() => {
          if (pcRef.current === pc && pc.iceConnectionState === "disconnected") {
            log.ice(`disconnected > ${ICE_DISCONNECTED_GRACE_MS}мс → restartIce()`);
            pc.restartIce();
          }
        }, ICE_DISCONNECTED_GRACE_MS);
        return;
      }

      if (s === "failed") {
        log.ice("failed → restartIce()");
        setStatus("reconnecting");
        pc.restartIce();
      }
    };

    pc.onnegotiationneeded = async () => {
      if (suppressNegotiationRef.current) {
        log.neg("negotiationneeded подавлен (начальный сетап receiver)");
        return;
      }
      try {
        log.neg("negotiationneeded, signalingState=", pc.signalingState);
        makingOfferRef.current = true;
        await pc.setLocalDescription();
        log.neg("→ отправляю offer:", describeSdp(pc.localDescription));
        send({ type: "offer", sdp: pc.localDescription });
      } catch (err) {
        log.err("negotiationneeded error:", err);
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
      log.media("демонстрация экрана запущена");
    } catch (err) {
      if (err.name !== "NotAllowedError") log.err("getDisplayMedia FAIL:", err);
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
    log.media("демонстрация экрана остановлена");
  }, []);

  /* ── Инициатор offer ── */
  const initAsInitiatorAndOffer = useCallback(async () => {
    log.neg("initAsInitiator: добавляю треки → negotiationneeded сам отправит offer");
    setStatus("connecting");
    const stream = await acquireMedia();
    const pc = await createPC();
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    preferLowLatencyCodecs(pc);
  }, [acquireMedia, createPC, preferLowLatencyCodecs]);

  /* ── Получатель первого offer ── */
  const initAsReceiverAndAnswer = useCallback(async (sdp) => {
    log.neg("initAsReceiver: создаю PC и отвечаю answer");
    setStatus("connecting");
    const stream = await acquireMedia();

    suppressNegotiationRef.current = true;
    const pc = await createPC();
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    preferLowLatencyCodecs(pc);

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    log.neg("remoteDescription установлен:", describeSdp(sdp));
    await pc.setLocalDescription();
    log.neg("→ отправляю answer:", describeSdp(pc.localDescription));
    send({ type: "answer", sdp: pc.localDescription });

    suppressNegotiationRef.current = false;

    // применяем буферизованные ICE-кандидаты
    if (pendingCandidatesRef.current.length) {
      log.ice("применяю", pendingCandidatesRef.current.length, "буферизованных кандидатов");
      for (const c of pendingCandidatesRef.current) {
        try { await pc.addIceCandidate(c); } catch (err) { log.warn("addIceCandidate (buffered):", err.message); }
      }
      pendingCandidatesRef.current = [];
    }
  }, [acquireMedia, createPC, preferLowLatencyCodecs, send]);

  /* ── Центральный обработчик «пир готов к звонку» ──
     Вызывается из обоих событий: и из role (для второго клиента),
     и из peer_joined (для первого клиента). Так исключается
     ситуация, когда никто не инициирует offer. */
  const onPeerReady = useCallback(async (polite) => {
    politeRef.current = polite;
    clearPeerDisconnectTimer();
    log.neg(`onPeerReady: polite=${polite}, роль=${polite ? "polite (ждёт)" : "impolite (инициатор)"}`);

    const pc = pcRef.current;
    if (pc && pc.connectionState !== "closed" && pc.connectionState !== "failed") {
      log.neg(`PC жив (state=${pc.connectionState}) — начальную инициацию пропускаю`);
      if (!polite &&
          (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed")) {
        log.neg("impolite + ICE не в порядке → restartIce");
        pc.restartIce();
      }
      return;
    }

    await acquireMedia();
    if (!polite) {
      await initAsInitiatorAndOffer();
    } else {
      setStatus("connecting");
      log.neg("polite: жду offer от impolite");
    }
  }, [acquireMedia, initAsInitiatorAndOffer]);

  /* ── Обработка offer/answer/candidate ── */
  const handleOffer = useCallback(async (sdp) => {
    const pc = pcRef.current;
    if (!pc) return;
    const offerCollision = makingOfferRef.current || pc.signalingState !== "stable";
    ignoreOfferRef.current = !politeRef.current && offerCollision;
    log.neg("handleOffer: collision=", offerCollision, "ignore=", ignoreOfferRef.current);
    if (ignoreOfferRef.current) return;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await pc.setLocalDescription();
    log.neg("→ отправляю answer:", describeSdp(pc.localDescription));
    send({ type: "answer", sdp: pc.localDescription });
  }, [send]);

  const handleAnswer = useCallback(async (sdp) => {
    const pc = pcRef.current;
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      log.neg("answer применён:", describeSdp(sdp));
    } catch (err) {
      log.warn("setRemoteDescription(answer):", err.message);
    }
  }, []);

  const handleIceCandidate = useCallback(async (candidate) => {
    const pc = pcRef.current;
    const ice = new RTCIceCandidate(candidate);
    log.ice("remote candidate ←", describeCandidate(candidate));
    if (!pc || !pc.remoteDescription) {
      pendingCandidatesRef.current.push(ice);
      log.ice("буферизую (PC не готов)");
      return;
    }
    try {
      await pc.addIceCandidate(ice);
    } catch (err) {
      if (!ignoreOfferRef.current) log.warn("addIceCandidate:", err.message);
    }
  }, []);

  const cleanup = useCallback(() => {
    log.pc("cleanup");
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

  /* ── Подписка на WS ── */
  useEffect(() => {
    const processMessage = async (data) => {
      try {
        switch (data.type) {
          case "role":
            log.ws("← role polite=", data.polite);
            if (typeof data.polite === "boolean") {
              // Пир уже в комнате — оба могут начинать
              await onPeerReady(data.polite);
            } else {
              // Пира ещё нет
              await acquireMedia();
              setStatus("waiting");
            }
            break;

          case "peer_joined":
            log.ws("← peer_joined polite=", data.polite);
            if (typeof data.polite === "boolean") {
              await onPeerReady(data.polite);
            }
            break;

          case "offer": {
            log.ws("← offer");
            const pc = pcRef.current;
            if (!pc || pc.signalingState === "closed") {
              await initAsReceiverAndAnswer(data.sdp);
            } else {
              await handleOffer(data.sdp);
            }
            break;
          }

          case "answer":
            log.ws("← answer");
            await handleAnswer(data.sdp);
            break;

          case "ice-candidate":
            await handleIceCandidate(data.candidate);
            break;

          case "peer_disconnected":
            log.ws("← peer_disconnected, grace", PEER_DISCONNECTED_GRACE_MS, "мс");
            clearPeerDisconnectTimer();
            peerDisconnectTimerRef.current = setTimeout(() => {
              log.pc("peer не вернулся, закрываю PC");
              closePc();
              setRemoteStream(null);
              setStatus("disconnected");
            }, PEER_DISCONNECTED_GRACE_MS);
            setStatus("reconnecting");
            break;
        }
      } catch (err) {
        log.err("processMessage:", err);
        setError(err.message);
      }
    };
    setOnMessage(processMessage);
  }, [
    setOnMessage, acquireMedia, onPeerReady, initAsReceiverAndAnswer,
    handleOffer, handleAnswer, handleIceCandidate, closePc,
  ]);

  useEffect(() => cleanup, [cleanup]);

  return {
    localStream, remoteStream, status, error, cleanup,
    isScreenSharing, startScreenShare, stopScreenShare: doStopScreenShare,
  };
}

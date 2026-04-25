import { useRef, useState, useCallback, useEffect } from "react";

import { log, describeCandidate, describeSdp } from "./logger";
import {
  ICE_DISCONNECTED_GRACE_MS,
  PEER_DISCONNECTED_GRACE_MS,
  ICE_RESTART_FAIL_TIMEOUT_MS,
  PC_RECREATE_AFTER_FAILURES,
  STATS_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  ICE_RESTART_WINDOW_MS,
  ICE_RESTART_LIMIT_IN_WINDOW,
} from "./config";
import { acquireMedia, stopStream, watchDeviceChanges } from "./lib/media";
import {
  createPeerConnection,
  preferLowLatencyCodecs,
  tuneReceiverLatency,
  tuneSenderParams,
} from "./lib/peerConnection";
import {
  startScreenShare as libStartScreenShare,
  stopScreenShare as libStopScreenShare,
} from "./lib/screenShare";
import { getSelectedPair, qualityLevel } from "./lib/stats";

/**
 * Главный WebRTC-хук. Оркестрирует:
 *   — медиа (lib/media)
 *   — PeerConnection (lib/peerConnection)
 *   — Perfect Negotiation (offer/answer/candidate)
 *   — ICE failure handling: restartIce → 2 провала подряд → пересоздание PC
 *   — индикатор качества и обмен состоянием камеры/микрофона
 */
export function useWebRTC({ send, setOnMessage }) {
  // ── PC и стримы ──
  const pcRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const screenStreamRef = useRef(null);

  // ── Perfect Negotiation ──
  const politeRef = useRef(false);
  const makingOfferRef = useRef(false);
  const ignoreOfferRef = useRef(false);
  const suppressNegotiationRef = useRef(false);

  // ── ICE / реконнект ──
  const iceConfigRef = useRef(null);
  const iceDisconnectTimerRef = useRef(null);
  const peerDisconnectTimerRef = useRef(null);
  const restartGuardTimerRef = useRef(null);
  const restartFailureCountRef = useRef(0);

  // ── Misc ──
  const statsIntervalRef = useRef(null);
  const pendingCandidatesRef = useRef([]);

  // ── Локальное media state (#15) ──
  const localMediaStateRef = useRef({ camera: true, mic: true });

  // ── Heartbeat по DataChannel (#4) ──
  const hbChannelRef = useRef(null);
  const hbSendTimerRef = useRef(null);
  const hbWatchdogRef = useRef(null);
  const lastHbPongRef = useRef(0);

  // ── Окно ICE restart-ов (#5) ──
  const restartHistoryRef = useRef([]);

  // ── React state ──
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [localMediaState, setLocalMediaStateState] = useState({ camera: true, mic: true });
  const [remoteMediaState, setRemoteMediaState] = useState({ camera: true, mic: true });
  const [connectionQuality, setConnectionQuality] = useState({
    rtt: null,
    level: "unknown",
    relayed: false,
  });

  // ── Хелперы для таймеров ──
  const clearIceDisconnectTimer = () => {
    clearTimeout(iceDisconnectTimerRef.current);
    iceDisconnectTimerRef.current = null;
  };
  const clearPeerDisconnectTimer = () => {
    clearTimeout(peerDisconnectTimerRef.current);
    peerDisconnectTimerRef.current = null;
  };
  const clearRestartGuard = () => {
    clearTimeout(restartGuardTimerRef.current);
    restartGuardTimerRef.current = null;
  };
  const clearStatsInterval = () => {
    clearInterval(statsIntervalRef.current);
    statsIntervalRef.current = null;
  };

  // ── ICE config ──
  const getIceConfig = useCallback(async () => {
    if (iceConfigRef.current) return iceConfigRef.current;
    log.ice("fetch /api/ice-config");
    const res = await fetch("/api/ice-config");
    const config = await res.json();
    log.ice("iceServers:", config.iceServers.map((s) => s.urls));
    iceConfigRef.current = config;
    return config;
  }, []);

  // ── Медиа ──
  const acquireMediaCached = useCallback(async () => {
    if (cameraStreamRef.current) {
      log.media("acquireMedia: stream уже получен");
      return cameraStreamRef.current;
    }
    const stream = await acquireMedia();
    log.media("getUserMedia OK:", stream.getTracks().map((t) => `${t.kind}:${t.label}`));
    cameraStreamRef.current = stream;
    setLocalStream(stream);

    // Применить текущее media state к свежим трекам
    const ms = localMediaStateRef.current;
    stream.getVideoTracks().forEach((t) => (t.enabled = ms.camera));
    stream.getAudioTracks().forEach((t) => (t.enabled = ms.mic));

    return stream;
  }, []);

  // ── Отправка media-state пиру (#15) ──
  const sendMediaStateToPeer = useCallback(
    (state) => {
      send({ type: "media-state", camera: state.camera, mic: state.mic });
    },
    [send],
  );

  // ── Управление локальной камерой/микрофоном (#15) ──
  const updateLocalMediaState = useCallback(
    (partial) => {
      const next = { ...localMediaStateRef.current, ...partial };
      localMediaStateRef.current = next;
      setLocalMediaStateState(next);

      const cam = cameraStreamRef.current;
      if (cam) {
        cam.getVideoTracks().forEach((t) => (t.enabled = next.camera));
        cam.getAudioTracks().forEach((t) => (t.enabled = next.mic));
      }

      sendMediaStateToPeer(next);
      log.media("local media state →", next);
    },
    [sendMediaStateToPeer],
  );

  const setLocalCameraEnabled = useCallback(
    (enabled) => updateLocalMediaState({ camera: enabled }),
    [updateLocalMediaState],
  );
  const setLocalMicEnabled = useCallback(
    (enabled) => updateLocalMediaState({ mic: enabled }),
    [updateLocalMediaState],
  );

  // ── Закрытие PC ──
  const closePc = useCallback(() => {
    if (pcRef.current) {
      log.pc("closePc: state был", pcRef.current.connectionState);
    }
    clearInterval(hbSendTimerRef.current);
    clearInterval(hbWatchdogRef.current);
    hbSendTimerRef.current = null;
    hbWatchdogRef.current = null;
    try { hbChannelRef.current?.close(); } catch { /* ok */ }
    hbChannelRef.current = null;
    clearIceDisconnectTimer();
    clearRestartGuard();
    clearStatsInterval();
    stopStream(screenStreamRef.current);
    screenStreamRef.current = null;
    setIsScreenSharing(false);
    makingOfferRef.current = false;
    ignoreOfferRef.current = false;
    suppressNegotiationRef.current = false;
    pendingCandidatesRef.current = [];
    pcRef.current?.close();
    pcRef.current = null;
    setConnectionQuality({ rtt: null, level: "unknown", relayed: false });
  }, []);

  // ── Создание PC ──
  // forwardRef для recreatePc — он использует initAsInitiatorAndOffer,
  // который определяется ниже. Распутываем циклическую зависимость через ref.
  const initAsInitiatorRef = useRef(null);

  const recreatePc = useCallback(async () => {
    log.pc("recreatePc: пересоздание PC после провалов restartIce");
    closePc();
    restartFailureCountRef.current = 0;
    setStatus("reconnecting");
    if (!politeRef.current) {
      // impolite инициирует новый offer
      await initAsInitiatorRef.current?.();
    } else {
      log.neg("polite: жду offer от impolite после recreatePc");
      await acquireMediaCached();
      setStatus("connecting");
    }
  }, [closePc, acquireMediaCached]);

  const handleIceFailure = useCallback(
    (pc) => {
      // если за окно уже было N рестартов — сразу recreatePc,
      // не пытаемся ещё раз restartIce (защита от каскадных циклов).
      const now = Date.now();
      restartHistoryRef.current = restartHistoryRef.current.filter(
        (t) => now - t < ICE_RESTART_WINDOW_MS,
      );
      if (restartHistoryRef.current.length >= ICE_RESTART_LIMIT_IN_WINDOW) {
        log.warn(
          `${ICE_RESTART_LIMIT_IN_WINDOW} рестартов за ${ICE_RESTART_WINDOW_MS}мс → recreatePc`,
        );
        restartHistoryRef.current = [];
        recreatePc();
        return;
      }
      restartHistoryRef.current.push(now);

      log.ice("вызов restartIce()");
      pc.restartIce();
      clearRestartGuard();
      restartGuardTimerRef.current = setTimeout(async () => {
        if (pcRef.current !== pc) return;
        const s = pc.iceConnectionState;
        if (s === "connected" || s === "completed") {
          restartFailureCountRef.current = 0;
          return;
        }
        restartFailureCountRef.current += 1;
        log.warn(
          `restartIce не помог за ${ICE_RESTART_FAIL_TIMEOUT_MS}мс ` +
            `(попытка ${restartFailureCountRef.current}/${PC_RECREATE_AFTER_FAILURES})`,
        );
        if (restartFailureCountRef.current >= PC_RECREATE_AFTER_FAILURES) {
          await recreatePc();
        } else {
          handleIceFailure(pc);
        }
      }, ICE_RESTART_FAIL_TIMEOUT_MS);
    },
    [recreatePc],
  );

  const startStatsLoop = useCallback((pc) => {
    clearStatsInterval();
    statsIntervalRef.current = setInterval(async () => {
      if (pcRef.current !== pc) return;
      const pair = await getSelectedPair(pc);
      if (!pair) return;
      const level = qualityLevel(pair.rtt_ms);
      setConnectionQuality({
        rtt: pair.rtt_ms,
        level,
        relayed: pair.relayed,
      });
      log.stats("пара:", {
        rtt: pair.rtt_ms,
        level,
        relayed: pair.relayed,
        local: pair.local && `${pair.local.type}/${pair.local.protocol}`,
        remote: pair.remote && `${pair.remote.type}/${pair.remote.protocol}`,
      });
    }, STATS_INTERVAL_MS);
  }, []);

  const createPC = useCallback(async () => {
    closePc();
    const config = await getIceConfig();

    log.pc("new RTCPeerConnection, polite=", politeRef.current);
    const pc = createPeerConnection(config.iceServers);
    pcRef.current = pc;

    const setupHeartbeat = (ch) => {
      hbChannelRef.current = ch;
      let restartAttempted = false;

      ch.onopen = () => {
        log.pc("heartbeat: канал открыт");
        lastHbPongRef.current = Date.now();

        hbSendTimerRef.current = setInterval(() => {
          if (ch.readyState !== "open") return;
          try { ch.send(JSON.stringify({ type: "ping" })); } catch { /* ok */ }
        }, HEARTBEAT_INTERVAL_MS);

        hbWatchdogRef.current = setInterval(() => {
          const silence = Date.now() - lastHbPongRef.current;
          if (silence < HEARTBEAT_TIMEOUT_MS) return;

          if (pcRef.current !== pc) return;

          if (!restartAttempted) {
            log.warn(`heartbeat: тишина ${silence}мс → restartIce`);
            restartAttempted = true;
            handleIceFailure(pc);
          } else {
            log.warn(`heartbeat: ${silence}мс после restartIce → пир мёртв`);
            clearInterval(hbWatchdogRef.current);
            hbWatchdogRef.current = null;
            closePc();
            setRemoteStream(null);
            setRemoteMediaState({ camera: true, mic: true });
            setStatus("disconnected");
          }
        }, HEARTBEAT_INTERVAL_MS);
      };

      ch.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "ping") {
            try { ch.send(JSON.stringify({ type: "pong" })); } catch { /* ok */ }
          } else if (msg.type === "pong") {
            lastHbPongRef.current = Date.now();
            restartAttempted = false;
          }
        } catch { /* ok */ }
      };

      ch.onclose = () => log.pc("heartbeat: канал закрыт");
      ch.onerror = (e) => log.warn("heartbeat: канал error", e);
    };

    if (!politeRef.current) {
      // impolite создаёт канал — он попадёт в первый offer
      const ch = pc.createDataChannel("hb", { ordered: true });
      setupHeartbeat(ch);
    } else {
      pc.ondatachannel = (e) => {
        if (e.channel.label === "hb") setupHeartbeat(e.channel);
      };
    }

    const remote = new MediaStream();
    setRemoteStream(remote);

    pc.ontrack = (e) => {
      log.media("ontrack:", e.track.kind, "id=", e.track.id);
      remote.getTracks().filter((t) => t.kind === e.track.kind).forEach((t) => remote.removeTrack(t));
      remote.addTrack(e.track);
      e.track.onended = () => remote.removeTrack(e.track);
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
        clearRestartGuard();
        restartFailureCountRef.current = 0;
        restartHistoryRef.current = [];
        setStatus("connected");
        tuneSenderParams(pc);
        tuneReceiverLatency(pc);
        startStatsLoop(pc);
        // Сообщаем пиру наше актуальное media state
        sendMediaStateToPeer(localMediaStateRef.current);
        return;
      }

      if (s === "disconnected") {
        setStatus("reconnecting");
        clearIceDisconnectTimer();
        iceDisconnectTimerRef.current = setTimeout(() => {
          if (pcRef.current === pc && pc.iceConnectionState === "disconnected") {
            log.ice(`disconnected > ${ICE_DISCONNECTED_GRACE_MS}мс → restartIce`);
            handleIceFailure(pc);
          }
        }, ICE_DISCONNECTED_GRACE_MS);
        return;
      }

      if (s === "failed") {
        log.ice("failed → restartIce");
        setStatus("reconnecting");
        handleIceFailure(pc);
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
  }, [
    closePc, getIceConfig, send, handleIceFailure,
    startStatsLoop, sendMediaStateToPeer,
  ]);

  // ── Демонстрация экрана ──
  const startScreenShareCmd = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc) return;
    try {
      const { screenStream, displayStream, screenVideoTrack } =
        await libStartScreenShare(pc, cameraStreamRef.current);
      screenStreamRef.current = screenStream;
      setLocalStream(displayStream);
      setIsScreenSharing(true);
      screenVideoTrack.onended = () => stopScreenShareCmd();
    } catch (err) {
      if (err.name !== "NotAllowedError") log.err("getDisplayMedia FAIL:", err);
    }
  }, []);

  const stopScreenShareCmd = useCallback(async () => {
    const pc = pcRef.current;
    const cam = cameraStreamRef.current;
    if (!pc || !cam) return;
    await libStopScreenShare(pc, cam, screenStreamRef.current);
    screenStreamRef.current = null;
    setLocalStream(cam);
    setIsScreenSharing(false);
  }, []);

  // ── Начальные сетапы ──
  const initAsInitiatorAndOffer = useCallback(async () => {
    log.neg("initAsInitiator: добавляю треки → negotiationneeded сам отправит offer");
    setStatus("connecting");
    const stream = await acquireMediaCached();
    const pc = await createPC();
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    preferLowLatencyCodecs(pc);
  }, [acquireMediaCached, createPC]);

  // Сохраняем в ref для использования в recreatePc
  initAsInitiatorRef.current = initAsInitiatorAndOffer;

  const initAsReceiverAndAnswer = useCallback(
    async (sdp) => {
      log.neg("initAsReceiver: создаю PC и отвечаю answer");
      setStatus("connecting");
      const stream = await acquireMediaCached();

      suppressNegotiationRef.current = true;
      const pc = await createPC();
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      preferLowLatencyCodecs(pc);

      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      log.neg("remoteDescription установлен:", describeSdp(sdp));
      await pc.setLocalDescription();
      log.neg("→ отправляю answer:", describeSdp(pc.localDescription));
      send({ type: "answer", sdp: pc.localDescription });

      suppressNegotiationRef.current = false;

      if (pendingCandidatesRef.current.length) {
        log.ice("применяю", pendingCandidatesRef.current.length, "буферизованных кандидатов");
        for (const c of pendingCandidatesRef.current) {
          try {
            await pc.addIceCandidate(c);
          } catch (err) {
            log.warn("addIceCandidate (buffered):", err.message);
          }
        }
        pendingCandidatesRef.current = [];
      }
    },
    [acquireMediaCached, createPC, send],
  );

  // ── onPeerReady (#10): различает живой/умерший PC ──
  const onPeerReady = useCallback(
    async (polite) => {
      politeRef.current = polite;
      clearPeerDisconnectTimer();
      log.neg(
        `onPeerReady: polite=${polite}, роль=${polite ? "polite (ждёт)" : "impolite (инициатор)"}`,
      );

      const pc = pcRef.current;
      if (pc) {
        const cs = pc.connectionState;
        // PC жив и в норме — ничего не делаем, начальный сетап не нужен
        if (cs === "connected" || cs === "connecting" || cs === "new") {
          log.neg(`PC жив (state=${cs}) — пропускаю инициацию`);
          if (
            !polite &&
            (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed")
          ) {
            log.neg("impolite + ICE проблема → restartIce");
            handleIceFailure(pc);
          }
          return;
        }
        // PC мёртв (failed/closed/disconnected долго) — пересоздаём
        if (cs === "failed" || cs === "closed" || cs === "disconnected") {
          log.neg(`PC в состоянии ${cs} → пересоздаю`);
          closePc();
        }
      }

      await acquireMediaCached();
      if (!polite) {
        await initAsInitiatorAndOffer();
      } else {
        setStatus("connecting");
        log.neg("polite: жду offer от impolite");
      }
    },
    [acquireMediaCached, initAsInitiatorAndOffer, closePc, handleIceFailure],
  );

  // ── Обработчики SDP / ICE ──
  const handleOffer = useCallback(
    async (sdp) => {
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
    },
    [send],
  );

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

  // ── Cleanup ──
  const cleanup = useCallback(() => {
    log.pc("cleanup");
    clearPeerDisconnectTimer();
    closePc();
    stopStream(cameraStreamRef.current);
    cameraStreamRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setStatus("idle");
    setError(null);
    iceConfigRef.current = null;
    setRemoteMediaState({ camera: true, mic: true });
    setLocalMediaStateState({ camera: true, mic: true });
    localMediaStateRef.current = { camera: true, mic: true };
  }, [closePc]);

  // ── Подписка на WS-сообщения ──
  useEffect(() => {
    const processMessage = async (data) => {
      try {
        switch (data.type) {
          case "role":
            log.ws("← role polite=", data.polite);
            if (typeof data.polite === "boolean") {
              await onPeerReady(data.polite);
            } else {
              await acquireMediaCached();
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

          case "media-state":
            log.ws("← media-state", data);
            setRemoteMediaState({
              camera: !!data.camera,
              mic: !!data.mic,
            });
            break;

          case "peer_disconnected": {
            const pc = pcRef.current;
            const alive =
              pc &&
              (pc.connectionState === "connected" || pc.connectionState === "connecting");

            if (alive) {
              log.ws(
                `← peer_disconnected, но PC жив (${pc.connectionState}) — игнорирую`,
              );
              break;
            }

            log.ws("← peer_disconnected + PC мёртв, grace", PEER_DISCONNECTED_GRACE_MS, "мс");
            clearPeerDisconnectTimer();
            peerDisconnectTimerRef.current = setTimeout(() => {
              log.pc("peer не вернулся → закрываю PC");
              closePc();
              setRemoteStream(null);
              setRemoteMediaState({ camera: true, mic: true });
              setStatus("disconnected");
            }, PEER_DISCONNECTED_GRACE_MS);
            setStatus("reconnecting");
            break;
          }

          case "peer_left":
            // Явное завершение звонка пиром — закрываем сразу, без grace.
            log.ws("← peer_left (пир явно завершил звонок)");
            clearPeerDisconnectTimer();
            closePc();
            setRemoteStream(null);
            setRemoteMediaState({ camera: true, mic: true });
            setStatus("disconnected");
            break;
        }
      } catch (err) {
        log.err("processMessage:", err);
        setError(err.message);
      }
    };
    setOnMessage(processMessage);
  }, [
    setOnMessage, acquireMediaCached, onPeerReady, initAsReceiverAndAnswer,
    handleOffer, handleAnswer, handleIceCandidate, closePc,
  ]);

  // ── devicechange listener (#13) ──
  useEffect(() => {
    const unwatch = watchDeviceChanges(() => {
      // Пока только логируем. UI-нотификация пользователю — отдельная задача.
    });
    return unwatch;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  return {
    localStream,
    remoteStream,
    status,
    error,
    cleanup,
    isScreenSharing,
    startScreenShare: startScreenShareCmd,
    stopScreenShare: stopScreenShareCmd,
    localMediaState,
    remoteMediaState,
    setLocalCameraEnabled,
    setLocalMicEnabled,
    connectionQuality,
  };
}

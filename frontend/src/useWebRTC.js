import { useRef, useState, useCallback, useEffect } from "react";

/**
 * WebRTC-логика: PeerConnection, SDP, trickle ICE, захват камеры.
 *
 * Реконнект:
 *  - ICE failed/disconnected → ICE restart (пересоздаём offer с iceRestart: true)
 *  - peer_disconnected → закрываем PC, ждём повторного подключения собеседника
 *  - WS реконнект (useSignaling) → получаем новую роль, пересоздаём PC
 */

const ICE_RESTART_DELAY = 2000;

export function useWebRTC({ send, setOnMessage }) {
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const roleRef = useRef(null);
  const iceQueueRef = useRef([]);
  const restartTimerRef = useRef(null);

  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);

  /* ── Медиа ── */

  const acquireMedia = useCallback(async () => {
    if (localStreamRef.current) return localStreamRef.current;
    console.log("[WebRTC] Запрашиваю getUserMedia...");
    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: true,
        });
      } catch {
        console.log("[WebRTC] Не удалось с ideal 720p, пробую video: true");
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
      }
      console.log("[WebRTC] getUserMedia OK, треки:",
        stream.getTracks().map(t => `${t.kind}=${t.readyState}, label=${t.label}`));
      localStreamRef.current = stream;
      setLocalStream(stream);
      return stream;
    } catch (err) {
      console.error("[WebRTC] getUserMedia FAIL:", err.name, err.message);
      throw err;
    }
  }, []);

  /* ── ICE Restart (caller инициирует пересогласование) ── */

  const scheduleIceRestart = useCallback(() => {
    if (restartTimerRef.current) return;
    const pc = pcRef.current;
    if (!pc || roleRef.current !== "caller") return;

    console.log(`[WebRTC] ICE restart запланирован через ${ICE_RESTART_DELAY}мс`);
    setStatus("reconnecting");

    restartTimerRef.current = setTimeout(async () => {
      restartTimerRef.current = null;
      const currentPc = pcRef.current;
      if (!currentPc || currentPc.signalingState === "closed") return;

      try {
        console.log("[WebRTC] Выполняю ICE restart...");
        const offer = await currentPc.createOffer({ iceRestart: true });
        await currentPc.setLocalDescription(offer);
        send({ type: "offer", sdp: currentPc.localDescription });
      } catch (err) {
        console.error("[WebRTC] ICE restart failed:", err);
      }
    }, ICE_RESTART_DELAY);
  }, [send]);

  /* ── PeerConnection ── */

  const closePc = useCallback(() => {
    clearTimeout(restartTimerRef.current);
    restartTimerRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    iceQueueRef.current = [];
  }, []);

  const createPC = useCallback(async () => {
    closePc();

    const res = await fetch("/api/ice-config");
    const config = await res.json();

    const pc = new RTCPeerConnection({ iceServers: config.iceServers });
    pcRef.current = pc;

    const remote = new MediaStream();
    setRemoteStream(remote);

    pc.ontrack = (e) => {
      console.log("[WebRTC] ontrack:", e.track.kind, e.track.readyState);
      e.streams[0].getTracks().forEach((track) => remote.addTrack(track));
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
        setStatus("connected");
      }

      // ICE restart при сбое (только caller инициирует)
      if (s === "disconnected") {
        setStatus("reconnecting");
        scheduleIceRestart();
      }
      if (s === "failed") {
        scheduleIceRestart();
      }
    };

    return pc;
  }, [send, closePc, scheduleIceRestart]);

  /* ── Сигналинг-обработчики ── */

  const drainIceQueue = useCallback(async (pc) => {
    for (const c of iceQueueRef.current) {
      await pc.addIceCandidate(new RTCIceCandidate(c));
    }
    iceQueueRef.current = [];
  }, []);

  const startCall = useCallback(async () => {
    setStatus("connecting");
    const stream = await acquireMedia();
    const pc = await createPC();
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: "offer", sdp: pc.localDescription });
  }, [acquireMedia, createPC, send]);

  const handleOffer = useCallback(
    async (sdp) => {
      setStatus("connecting");
      const stream = await acquireMedia();

      // Если PC уже существует — это ICE restart, не создаём новый
      let pc = pcRef.current;
      if (!pc || pc.signalingState === "closed") {
        pc = await createPC();
        stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      }

      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await drainIceQueue(pc);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: "answer", sdp: pc.localDescription });
    },
    [acquireMedia, createPC, drainIceQueue, send],
  );

  const handleAnswer = useCallback(
    async (sdp) => {
      const pc = pcRef.current;
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await drainIceQueue(pc);
    },
    [drainIceQueue],
  );

  const handleIceCandidate = useCallback(async (candidate) => {
    const pc = pcRef.current;
    if (pc?.remoteDescription) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } else {
      iceQueueRef.current.push(candidate);
    }
  }, []);

  const cleanup = useCallback(() => {
    closePc();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setStatus("idle");
  }, [closePc]);

  /* ── Подписка на входящие WS-сообщения ── */

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
            await startCall();
            break;

          case "offer":
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
        console.error("WebRTC error:", err);
        setError(err.message);
      }
    };

    setOnMessage(processMessage);
  }, [setOnMessage, acquireMedia, startCall, handleOffer, handleAnswer, handleIceCandidate, closePc]);

  useEffect(() => cleanup, [cleanup]);

  return { localStream, remoteStream, status, error, cleanup };
}

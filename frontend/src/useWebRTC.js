// frontend/src/useWebRTC.js
import { useRef, useState, useCallback, useEffect } from "react";

/**
 * WebRTC: PeerConnection, SDP, trickle ICE, камера, демонстрация экрана, чат.
 *
 * Демонстрация экрана: removeTrack + addTrack + ренегоциация (НЕ replaceTrack).
 * Это надёжнее replaceTrack т.к. вызывает ontrack на ресивере с новым треком.
 */

const ICE_RESTART_DELAY = 2000;

export function useWebRTC({ send, setOnMessage }) {
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const remoteRef = useRef(null);
  const roleRef = useRef(null);
  const iceQueueRef = useRef([]);
  const restartTimerRef = useRef(null);
  const cameraTrackRef = useRef(null);

  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);

  /* ── Медиа ── */

  const acquireMedia = useCallback(async () => {
    if (localStreamRef.current) return localStreamRef.current;
    console.log("[WebRTC] Запрашиваю getUserMedia...");

    const attempts = [
      { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true },
      { video: true, audio: true },
      { video: false, audio: true },
      { video: true, audio: false },
    ];

    let stream = null;
    for (const constraints of attempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (err) {
        console.warn("[WebRTC] getUserMedia fail для", constraints, ":", err.name);
      }
    }

    if (!stream) {
      console.warn("[WebRTC] Нет доступа к камере и микрофону, подключаюсь без медиа");
      stream = new MediaStream();
    }

    console.log("[WebRTC] getUserMedia OK, треки:",
      stream.getTracks().map(t => `${t.kind}=${t.readyState}`));
    localStreamRef.current = stream;
    cameraTrackRef.current = stream.getVideoTracks()[0] || null;
    setLocalStream(stream);
    return stream;
  }, []);

  /* ── Чат ── */

  const sendChat = useCallback((text) => {
    if (!text.trim()) return;
    send({ type: "chat", text: text.trim() });
    setChatMessages(prev => [...prev, { text: text.trim(), own: true, ts: Date.now() }]);
  }, [send]);

  /* ── Ренегоциация (общая) ── */

  const renegotiate = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || pc.signalingState === "closed") return;
    console.log("[WebRTC] Ренегоциация, signalingState:", pc.signalingState);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: "offer", sdp: pc.localDescription });
  }, [send]);

  /* ── Демонстрация экрана ── */

  const startScreenShare = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc) return;

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      screenStreamRef.current = screenStream;
      const screenVideoTrack = screenStream.getVideoTracks()[0];
      console.log("[WebRTC] Screen track получен:", screenVideoTrack.readyState);

      // Убираем камеру из PC
      const camSender = pc.getSenders().find(s => s.track?.kind === "video");
      if (camSender) {
        pc.removeTrack(camSender);
        console.log("[WebRTC] Камера убрана из PC");
      }

      // Добавляем экран
      pc.addTrack(screenVideoTrack, screenStream);
      console.log("[WebRTC] Screen track добавлен в PC");

      // Ренегоциация — ресивер получит ontrack с новым треком
      await renegotiate();

      // PiP
      const displayStream = new MediaStream([
        screenVideoTrack,
        ...(localStreamRef.current?.getAudioTracks() || []),
      ]);
      setLocalStream(displayStream);
      setIsScreenSharing(true);

      screenVideoTrack.onended = () => stopScreenShare();
      console.log("[WebRTC] Демонстрация экрана запущена");
    } catch (err) {
      if (err.name !== "NotAllowedError") {
        console.error("[WebRTC] getDisplayMedia FAIL:", err);
      }
    }
  }, [renegotiate]);

  const stopScreenShare = useCallback(async () => {
    const pc = pcRef.current;
    const cameraStream = localStreamRef.current;
    const screenStream = screenStreamRef.current;
    if (!pc || !cameraStream) return;

    // Убираем экранные sender'ы
    pc.getSenders().forEach(sender => {
      if (sender.track && sender.track !== cameraTrackRef.current &&
          !cameraStream.getAudioTracks().includes(sender.track)) {
        try { pc.removeTrack(sender); } catch { /* ok */ }
      }
    });

    // Возвращаем камеру
    const camTrack = cameraTrackRef.current;
    if (camTrack && camTrack.readyState === "live") {
      pc.addTrack(camTrack, cameraStream);
    }

    // Останавливаем треки экрана
    screenStream?.getTracks().forEach(t => t.stop());
    screenStreamRef.current = null;

    // Ренегоциация
    await renegotiate();

    setLocalStream(cameraStream);
    setIsScreenSharing(false);
    console.log("[WebRTC] Демонстрация экрана остановлена");
  }, [renegotiate]);

  /* ── ICE Restart ── */

  const scheduleIceRestart = useCallback(() => {
    if (restartTimerRef.current) return;
    const pc = pcRef.current;
    if (!pc) return;

    console.log(`[WebRTC] ICE restart через ${ICE_RESTART_DELAY}мс`);
    setStatus("reconnecting");

    restartTimerRef.current = setTimeout(async () => {
      restartTimerRef.current = null;
      const currentPc = pcRef.current;
      if (!currentPc || currentPc.signalingState === "closed") return;

      try {
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
    screenStreamRef.current?.getTracks().forEach(t => t.stop());
    screenStreamRef.current = null;
    setIsScreenSharing(false);
    pcRef.current?.close();
    pcRef.current = null;
    remoteRef.current = null;
    iceQueueRef.current = [];
  }, []);

  const createPC = useCallback(async () => {
    closePc();

    const res = await fetch("/api/ice-config");
    const config = await res.json();

    const pc = new RTCPeerConnection({ iceServers: config.iceServers });
    pcRef.current = pc;

    const remote = new MediaStream();
    remoteRef.current = remote;
    setRemoteStream(remote);

    pc.ontrack = (e) => {
      console.log("[WebRTC] ontrack:", e.track.kind, e.track.readyState, "id:", e.track.id);
      const r = remoteRef.current;
      if (!r) return;

      // Убираем старые треки того же типа (при переключении камера↔экран)
      r.getTracks()
        .filter(t => t.kind === e.track.kind && t.id !== e.track.id)
        .forEach(t => r.removeTrack(t));

      r.addTrack(e.track);

      // Новый MediaStream → Video перемонтирует <video> элемент
      const ns = new MediaStream(r.getTracks());
      remoteRef.current = ns;
      setRemoteStream(ns);
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
        setStatus("connected");
      }
      if (s === "disconnected" || s === "failed") {
        setStatus("reconnecting");
        scheduleIceRestart();
      }
    };

    return pc;
  }, [send, closePc, scheduleIceRestart]);

  /* ── Сигналинг ── */

  const drainIceQueue = useCallback(async (pc) => {
    for (const c of iceQueueRef.current) {
      await pc.addIceCandidate(new RTCIceCandidate(c));
    }
    iceQueueRef.current = [];
  }, []);

  const ensureTransceivers = useCallback((pc, stream) => {
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    const hasAudio = stream.getAudioTracks().length > 0;
    const hasVideo = stream.getVideoTracks().length > 0;
    if (!hasAudio) pc.addTransceiver("audio", { direction: "recvonly" });
    if (!hasVideo) pc.addTransceiver("video", { direction: "recvonly" });
  }, []);

  const startCall = useCallback(async () => {
    setStatus("connecting");
    const stream = await acquireMedia();
    const pc = await createPC();
    ensureTransceivers(pc, stream);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: "offer", sdp: pc.localDescription });
  }, [acquireMedia, createPC, ensureTransceivers, send]);

  const handleOffer = useCallback(
    async (sdp) => {
      let pc = pcRef.current;

      // ── Ренегоциация: PC уже есть, НЕ пересоздаём ──
      if (pc && pc.signalingState !== "closed") {
        console.log("[WebRTC] handleOffer: ренегоциация, state:", pc.signalingState);
        if (pc.signalingState === "have-local-offer") {
          await pc.setLocalDescription({ type: "rollback" });
        }
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        await drainIceQueue(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({ type: "answer", sdp: pc.localDescription });
        return;
      }

      // ── Первое подключение ──
      console.log("[WebRTC] handleOffer: новый PC");
      setStatus("connecting");
      const stream = await acquireMedia();
      pc = await createPC();
      ensureTransceivers(pc, stream);
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await drainIceQueue(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: "answer", sdp: pc.localDescription });
    },
    [acquireMedia, createPC, ensureTransceivers, drainIceQueue, send],
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
    if (!candidate?.candidate) return;
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
    cameraTrackRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setStatus("idle");
    setChatMessages([]);
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
          case "chat":
            setChatMessages(prev => [...prev, { text: data.text, own: false, ts: Date.now() }]);
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

  return {
    localStream, remoteStream, status, error, cleanup,
    isScreenSharing, startScreenShare, stopScreenShare,
    chatMessages, sendChat,
  };
}

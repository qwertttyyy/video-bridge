import { log } from "../logger";


function getAudioContextCtor() {
  return globalThis.AudioContext || globalThis.webkitAudioContext || null;
}


function createTrackStream(track) {
  return new MediaStream([track]);
}


function stopTrack(track) {
  try { track?.stop?.(); } catch { /* ok */ }
}


export function disposeScreenShare(screenShare) {
  const screenStream = screenShare?.screenStream || screenShare;
  screenStream?.getTracks?.().forEach(stopTrack);
  stopTrack(screenShare?.mixedAudioTrack);
  try { screenShare?.audioContext?.close?.(); } catch { /* ok */ }
}


/**
 * Запускает демонстрацию экрана. Если браузер вернул аудиотрек
 * демонстрации, отправляет его в PeerConnection: миксует с микрофоном
 * через Web Audio API либо отправляет screen-audio как отдельный трек.
 */
export async function startScreenShare(pc, cameraStream) {
  const screenStream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true,
  });
  const screenVideoTrack = screenStream.getVideoTracks()[0];
  const screenAudioTrack = screenStream.getAudioTracks()[0] || null;
  const micAudioTrack = cameraStream?.getAudioTracks()[0] || null;
  const senders = pc.getSenders();

  const videoSender = senders.find((s) => s.track?.kind === "video");
  if (videoSender && screenVideoTrack) {
    await videoSender.replaceTrack(screenVideoTrack);
  }

  const audioSender = senders.find((s) => s.track?.kind === "audio");
  let audioMode = "mic-only";
  let audioContext = null;
  let mixedAudioTrack = null;

  if (audioSender && screenAudioTrack) {
    const AudioContextCtor = getAudioContextCtor();
    if (micAudioTrack && AudioContextCtor) {
      audioContext = new AudioContextCtor();
      try { await audioContext.resume?.(); } catch { /* ok */ }

      const destination = audioContext.createMediaStreamDestination();
      const micSource = audioContext.createMediaStreamSource(createTrackStream(micAudioTrack));
      const screenSource = audioContext.createMediaStreamSource(createTrackStream(screenAudioTrack));
      micSource.connect(destination);
      screenSource.connect(destination);

      mixedAudioTrack = destination.stream.getAudioTracks()[0] || null;
      if (mixedAudioTrack) {
        await audioSender.replaceTrack(mixedAudioTrack);
        audioMode = "mixed";
      }
    }

    if (!mixedAudioTrack) {
      await audioSender.replaceTrack(screenAudioTrack);
      audioMode = "screen-only";
    }
  } else if (screenAudioTrack) {
    audioMode = "screen-audio-no-sender";
  }

  const displayStream = new MediaStream([
    screenVideoTrack,
    ...(cameraStream?.getAudioTracks() || []),
  ].filter(Boolean));

  log.media("демонстрация экрана запущена", {
    hasScreenAudio: !!screenAudioTrack,
    audioMode,
  });
  return {
    screenStream,
    displayStream,
    screenVideoTrack,
    screenAudioTrack,
    mixedAudioTrack,
    audioContext,
    audioMode,
  };
}


/**
 * Останавливает демонстрацию: возвращает камеру и микрофон в отправители,
 * глушит экран-стрим и временный mixed audio track. Не закрывает PC.
 */
export async function stopScreenShare(pc, cameraStream, screenShare) {
  disposeScreenShare(screenShare);

  const camVideo = cameraStream?.getVideoTracks()[0];
  if (camVideo) {
    const videoSender = pc.getSenders().find((s) => s.track?.kind === "video");
    if (videoSender) await videoSender.replaceTrack(camVideo);
  }

  const micAudio = cameraStream?.getAudioTracks()[0];
  if (micAudio) {
    const audioSender = pc.getSenders().find((s) => s.track?.kind === "audio");
    if (audioSender) await audioSender.replaceTrack(micAudio);
  }

  log.media("демонстрация экрана остановлена");
}

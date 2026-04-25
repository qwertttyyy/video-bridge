import { log } from "../logger";

/**
 * Запускает демонстрацию экрана, заменяет видео-трек у отправителя
 * на захват дисплея. Возвращает экран-стрим и комбинированный
 * "display" стрим (экран + микрофон) для локального превью.
 */
export async function startScreenShare(pc, cameraStream) {
  const screenStream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true,
  });
  const screenVideoTrack = screenStream.getVideoTracks()[0];

  const videoSender = pc.getSenders().find((s) => s.track?.kind === "video");
  if (videoSender && screenVideoTrack) {
    await videoSender.replaceTrack(screenVideoTrack);
  }

  const displayStream = new MediaStream([
    screenVideoTrack,
    ...(cameraStream?.getAudioTracks() || []),
  ]);

  log.media("демонстрация экрана запущена");
  return { screenStream, displayStream, screenVideoTrack };
}

/**
 * Останавливает демонстрацию: возвращает камеру в отправитель,
 * глушит экран-стрим. Не закрывает PC.
 */
export async function stopScreenShare(pc, cameraStream, screenStream) {
  screenStream?.getTracks().forEach((t) => t.stop());
  const camVideo = cameraStream?.getVideoTracks()[0];
  if (camVideo) {
    const videoSender = pc.getSenders().find((s) => s.track?.kind === "video");
    if (videoSender) await videoSender.replaceTrack(camVideo);
  }
  log.media("демонстрация экрана остановлена");
}

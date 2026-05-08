import { log } from "../logger";

export const NOISE_SUPPRESSION_STORAGE_KEY = "vb-noise-suppression";

export function getStoredNoiseSuppressionEnabled() {
  return localStorage.getItem(NOISE_SUPPRESSION_STORAGE_KEY) !== "off";
}

export function buildAudioConstraints(noiseSuppressionEnabled = getStoredNoiseSuppressionEnabled()) {
  return {
    echoCancellation: true,
    noiseSuppression: noiseSuppressionEnabled,
    autoGainControl: true,
  };
}

export async function applyAudioProcessingConstraints(stream, noiseSuppressionEnabled) {
  if (!stream) return;

  const constraints = buildAudioConstraints(noiseSuppressionEnabled);
  const results = await Promise.allSettled(
    stream.getAudioTracks().map((track) => track.applyConstraints(constraints)),
  );

  results.forEach((result) => {
    if (result.status === "rejected") {
      log.warn("apply audio constraints failed:", result.reason);
    }
  });
}

/**
 * Запрос камеры и микрофона. Сначала пробуем HD,
 * при отказе — базовый запрос.
 */
export async function acquireMedia() {
  const audio = buildAudioConstraints();

  log.media("getUserMedia: HD");
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio,
    });
  } catch (err) {
    log.warn("getUserMedia HD failed:", err.name, "→ fallback");
    return await navigator.mediaDevices.getUserMedia({ video: true, audio });
  }
}

/** Останавливает все треки в стриме. */
export function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

/**
 * Подписка на изменения списка устройств (подключили/отключили
 * наушники, гарнитуру, веб-камеру). Возвращает функцию отписки.
 */
export function watchDeviceChanges(onChange) {
  const handler = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      log.media("devicechange:", devices.map((d) => `${d.kind}:${d.label || "(скрыто)"}`));
      onChange(devices);
    } catch (err) {
      log.warn("enumerateDevices failed:", err);
    }
  };
  navigator.mediaDevices.addEventListener("devicechange", handler);
  return () => navigator.mediaDevices.removeEventListener("devicechange", handler);
}

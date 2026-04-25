import { log } from "../logger";

/**
 * Запрос камеры и микрофона. Сначала пробуем HD,
 * при отказе — базовый запрос.
 */
export async function acquireMedia() {
  log.media("getUserMedia: HD");
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    log.warn("getUserMedia HD failed:", err.name, "→ fallback");
    return await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
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

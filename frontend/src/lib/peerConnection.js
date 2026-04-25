import {
  CANDIDATE_POOL_SIZE,
  JITTER_BUFFER_MS,
  MAX_VIDEO_BITRATE,
} from "../config";

/** Создаёт RTCPeerConnection с настройками для одного звонка 1:1. */
export function createPeerConnection(iceServers) {
  return new RTCPeerConnection({
    iceServers,
    iceCandidatePoolSize: CANDIDATE_POOL_SIZE,
    bundlePolicy: "max-bundle",
  });
}

/**
 * Перестановка приоритета видео-кодеков: VP8 → H264 → остальные.
 * VP8 обычно даёт лучшую совместимость и низкую задержку без аппаратного
 * кодирования. Метод не везде поддерживается — заворачиваем в try/catch.
 */
export function preferLowLatencyCodecs(pc) {
  if (!pc.getTransceivers) return;
  for (const tr of pc.getTransceivers()) {
    if (tr.receiver.track?.kind !== "video") continue;
    if (!tr.setCodecPreferences) continue;
    try {
      const codecs = RTCRtpReceiver.getCapabilities("video")?.codecs || [];
      const sorted = [
        ...codecs.filter((c) => c.mimeType === "video/VP8"),
        ...codecs.filter((c) => c.mimeType === "video/H264"),
        ...codecs.filter((c) => c.mimeType !== "video/VP8" && c.mimeType !== "video/H264"),
      ];
      tr.setCodecPreferences(sorted);
    } catch {
      /* не все браузеры — ок */
    }
  }
}

/** Уменьшает джиттер-буфер у получателей и подсказывает не задерживать воспроизведение. */
export function tuneReceiverLatency(pc) {
  for (const r of pc.getReceivers()) {
    if (typeof r.jitterBufferTarget !== "undefined") {
      r.jitterBufferTarget = JITTER_BUFFER_MS / 1000;
    }
    if (typeof r.playoutDelayHint !== "undefined") {
      r.playoutDelayHint = 0;
    }
  }
}

/** Ограничивает максимальный битрейт видео у отправителей. */
export async function tuneSenderParams(pc) {
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
    try {
      await sender.setParameters(params);
    } catch {
      /* ok */
    }
  }
}

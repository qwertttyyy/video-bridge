// ── PeerConnection ──
export const CANDIDATE_POOL_SIZE = 4;
export const JITTER_BUFFER_MS = 50;
export const MAX_VIDEO_BITRATE = 2_500_000;

// ── Тайминги реконнекта ──
export const ICE_DISCONNECTED_GRACE_MS = 5000;    // ждём само-восстановления перед restartIce
export const PEER_DISCONNECTED_GRACE_MS = 5000;   // ждём пира перед закрытием PC
export const ICE_RESTART_FAIL_TIMEOUT_MS = 8000; // если после restartIce не пришли в connected
export const PC_RECREATE_AFTER_FAILURES = 2;     // пересоздать PC после N подряд провалов

// ── Сигналинг ──
export const RECONNECT_INITIAL_DELAY_MS = 500;
export const RECONNECT_MAX_DELAY_MS = 5000;

// ── Статистика и UI ──
export const STATS_INTERVAL_MS = 5000;            // частота опроса getStats для индикатора качества
export const QUALITY_RTT_GOOD_MS = 100;
export const QUALITY_RTT_OK_MS = 250;

// ── Heartbeat по DataChannel (пункт 4) ──
export const HEARTBEAT_INTERVAL_MS = 5000;        // частота ping
export const HEARTBEAT_TIMEOUT_MS = 10000;        // тишина → пир мёртв

// ── Защита от каскадных ICE restart (пункт 5) ──
export const ICE_RESTART_WINDOW_MS = 15000;       // окно для подсчёта рестартов
export const ICE_RESTART_LIMIT_IN_WINDOW = 2;     // больше → сразу recreatePc
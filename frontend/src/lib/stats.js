import { QUALITY_RTT_GOOD_MS, QUALITY_RTT_OK_MS } from "../config";

/**
 * Считывает текущую "работающую" ICE-пару и ключевые метрики.
 * Возвращает null, если пара ещё не выбрана.
 */
export async function getSelectedPair(pc) {
  if (!pc || pc.connectionState === "closed") return null;
  try {
    const stats = await pc.getStats();
    let pair = null;
    const cands = new Map();
    for (const s of stats.values()) {
      if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") {
        pair = s;
      }
      if (s.type === "local-candidate" || s.type === "remote-candidate") {
        cands.set(s.id, s);
      }
    }
    if (!pair) return null;
    const local = cands.get(pair.localCandidateId);
    const remote = cands.get(pair.remoteCandidateId);
    return {
      rtt_ms:
        pair.currentRoundTripTime != null
          ? Math.round(pair.currentRoundTripTime * 1000)
          : null,
      relayed:
        local?.candidateType === "relay" || remote?.candidateType === "relay",
      local: local && {
        type: local.candidateType,
        protocol: local.protocol,
        address: local.address,
        port: local.port,
      },
      remote: remote && {
        type: remote.candidateType,
        protocol: remote.protocol,
        address: remote.address,
        port: remote.port,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Перевод RTT в человеко-понятный уровень качества.
 * good — зелёный, ok — жёлтый, poor — красный.
 */
export function qualityLevel(rttMs) {
  if (rttMs == null) return "unknown";
  if (rttMs <= QUALITY_RTT_GOOD_MS) return "good";
  if (rttMs <= QUALITY_RTT_OK_MS) return "ok";
  return "poor";
}

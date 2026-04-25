/**
 * Структурированные логи для отладки WebRTC.
 * Каждый канал со своим цветом и префиксом — легко фильтровать в DevTools.
 */

const DEBUG = true; // переключить на false в проде

const ts = () => {
  const d = new Date();
  return (
    d.toTimeString().slice(0, 8) +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
};

const make = (tag, color) => (...args) => {
  if (!DEBUG) return;
  console.log(`%c${ts()} ${tag}`, `color:${color};font-weight:bold`, ...args);
};

export const log = {
  ws:    make("[WS]",    "#09f"),
  pc:    make("[PC]",    "#0c8"),
  ice:   make("[ICE]",   "#e80"),
  neg:   make("[NEG]",   "#d0a"),
  media: make("[MEDIA]", "#8c0"),
  stats: make("[STATS]", "#888"),
  warn:  (...args) => console.warn(`${ts()} [WARN]`, ...args),
  err:   (...args) => console.error(`${ts()} [ERR]`, ...args),
};

/** Краткое описание ICE-кандидата для лога. */
export function describeCandidate(c) {
  if (!c) return "null";
  if (c.type) {
    return `${c.type}/${c.protocol} ${c.address || c.ip}:${c.port}`;
  }
  const m = c.candidate?.match(/typ (\S+).+?(\d+\.\d+\.\d+\.\d+)\s+(\d+)/);
  return m ? `${m[1]} ${m[2]}:${m[3]}` : c.candidate?.slice(0, 80) || "?";
}

/** Краткое описание SDP для лога. */
export function describeSdp(sdp) {
  if (!sdp) return "null";
  const s = typeof sdp === "string" ? sdp : sdp.sdp || "";
  return {
    type: typeof sdp === "string" ? "raw" : sdp.type,
    bytes: s.length,
    m_lines: (s.match(/^m=/gm) || []).length,
    has_ice_restart_hint: /a=ice-ufrag/.test(s),
  };
}

/** Логирует итоговую выбранную ICE-пару и ключевые метрики. */
export async function logSelectedPair(pc, tag = "") {
  if (!pc || pc.connectionState === "closed") return;
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
    if (!pair) {
      log.stats(tag, "выбранная пара ещё не определена");
      return;
    }
    const local = cands.get(pair.localCandidateId);
    const remote = cands.get(pair.remoteCandidateId);
    log.stats(tag || "выбранная пара", {
      local:  local  && `${local.candidateType}/${local.protocol} ${local.address}:${local.port}`,
      remote: remote && `${remote.candidateType}/${remote.protocol} ${remote.address}:${remote.port}`,
      rtt_ms: pair.currentRoundTripTime != null
        ? Math.round(pair.currentRoundTripTime * 1000)
        : "—",
      relayed: local?.candidateType === "relay" || remote?.candidateType === "relay",
    });
  } catch (err) {
    log.warn("logSelectedPair failed:", err);
  }
}

import "./QualityIndicator.css";

/**
 * Индикатор качества связи: цветная точка + RTT + значок relay.
 * level: "good" | "ok" | "poor" | "unknown"
 */
export function QualityIndicator({ rtt, level, relayed }) {
  const title =
    rtt == null
      ? "Качество связи неизвестно"
      : `RTT: ${rtt} мс${relayed ? " (через TURN)" : ""}`;

  return (
    <div className="quality-indicator" title={title}>
      <span className={`quality-dot quality-${level}`} />
      {rtt != null && <span className="quality-rtt">{rtt} мс</span>}
      {relayed && <span className="quality-relay" title="Соединение через TURN-relay">⟲</span>}
    </div>
  );
}

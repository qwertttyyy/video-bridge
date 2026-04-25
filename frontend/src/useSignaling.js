import { useRef, useCallback, useState } from "react";
import { log } from "./logger";
import {
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
} from "./config";

/**
 * WebSocket-сигналинг с автореконнектом, keepalive и backoff.
 *
 * Сервер шлёт ping каждые 20с → клиент отвечает pong.
 * При обрыве — exponential backoff с джиттером.
 * Race-fix: события onclose/onerror старого WS игнорируются,
 * если в wsRef уже сидит новый.
 */
export function useSignaling() {
  const wsRef = useRef(null);
  const onMessageRef = useRef(null);
  const onDisconnectRef = useRef(null);
  const paramsRef = useRef(null);
  const intentionalCloseRef = useRef(false);
  const reconnectTimerRef = useRef(null);
  const delayRef = useRef(RECONNECT_INITIAL_DELAY_MS);

  const [connected, setConnected] = useState(false);

  const rawSend = useCallback((data) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
      if (data.type !== "pong") log.ws("→", data.type);
      return true;
    }
    log.warn("send пропущен, WS не OPEN:", data.type);
    return false;
  }, []);

  const doConnect = useCallback(
    (sessionKey, clientId) => {
      // Закрыть предыдущий, если был
      const prev = wsRef.current;
      if (prev) {
        // Помечаем именно эту ссылку как "intentional close"
        // через локальный флаг не получится — используем сравнение по ссылке ниже
        prev.close();
      }

      paramsRef.current = { sessionKey, clientId };
      intentionalCloseRef.current = false;

      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const url = `${proto}://${window.location.host}/ws/${sessionKey}/${clientId}`;
      log.ws("подключаюсь:", url);

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (ws !== wsRef.current) return; // устаревшая ссылка
        log.ws("open, clientId=", clientId);
        setConnected(true);
        delayRef.current = RECONNECT_INITIAL_DELAY_MS;
      };

      ws.onclose = (e) => {
        // Race-fix: события старого WS игнорируем,
        // если уже создан новый.
        if (ws !== wsRef.current) {
          log.ws("close (старая ссылка) — игнорирую");
          return;
        }
        log.ws("close code=", e.code, "reason=", e.reason || "—");
        setConnected(false);
        wsRef.current = null;

        // Серверный отказ — реконнект бесполезен
        if (e.code === 4001 || e.code === 4002 || e.code === 4003) {
          onDisconnectRef.current?.(e.code, e.reason);
          return;
        }

        if (intentionalCloseRef.current || !paramsRef.current) return;

        // Exponential backoff с джиттером ±30% (несинхронизированный реконнект)
        const base = delayRef.current;
        delayRef.current = Math.min(base * 2, RECONNECT_MAX_DELAY_MS);
        const jitter = 1 + (Math.random() * 0.6 - 0.3);
        const delay = Math.floor(base * jitter);
        log.ws(`реконнект через ${delay}мс`);
        reconnectTimerRef.current = setTimeout(() => {
          const p = paramsRef.current;
          if (p) doConnect(p.sessionKey, p.clientId);
        }, delay);
      };

      ws.onerror = (e) => {
        if (ws !== wsRef.current) return;
        log.warn("WS error", e);
      };

      ws.onmessage = (event) => {
        if (ws !== wsRef.current) return;
        const data = JSON.parse(event.data);
        if (data.type === "ping") {
          rawSend({ type: "pong" });
          return;
        }
        onMessageRef.current?.(data);
      };
    },
    [rawSend],
  );

  const connect = useCallback(
    (sessionKey, clientId) => doConnect(sessionKey, clientId),
    [doConnect],
  );

  const send = useCallback((data) => rawSend(data), [rawSend]);

  const setOnMessage = useCallback((handler) => {
    onMessageRef.current = handler;
  }, []);

  const setOnDisconnect = useCallback((handler) => {
    onDisconnectRef.current = handler;
  }, []);

  const disconnect = useCallback(() => {
    log.ws("disconnect (intentional)");
    intentionalCloseRef.current = true;
    paramsRef.current = null;
    clearTimeout(reconnectTimerRef.current);
    wsRef.current?.close();
    wsRef.current = null;
    setConnected(false);
  }, []);

  return {
    connect,
    send,
    setOnMessage,
    setOnDisconnect,
    disconnect,
    connected,
  };
}

// frontend/src/useSignaling.js
import { useRef, useCallback, useState } from "react";

const MAX_RECONNECT_DELAY = 8000;
const INITIAL_RECONNECT_DELAY = 500;

/**
 * WebSocket-сигналинг с автореконнектом и keepalive.
 *
 * Сервер шлёт ping каждые 20с → клиент отвечает pong.
 * При обрыве — exponential backoff реконнект.
 */
export function useSignaling() {
  const wsRef = useRef(null);
  const onMessageRef = useRef(null);
  const onDisconnectRef = useRef(null);
  const paramsRef = useRef(null);
  const intentionalClose = useRef(false);
  const reconnectTimer = useRef(null);
  const delayRef = useRef(INITIAL_RECONNECT_DELAY);

  const [connected, setConnected] = useState(false);

  const rawSend = useCallback((data) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
      return true;
    }
    return false;
  }, []);

  const doConnect = useCallback((sessionKey, clientId) => {
    // Закрываем предыдущее соединение
    if (wsRef.current) {
      intentionalClose.current = true;
      wsRef.current.close();
    }

    intentionalClose.current = false;
    paramsRef.current = { sessionKey, clientId };

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${window.location.host}/ws/${sessionKey}/${clientId}`;

    console.log("[WS] Подключаюсь:", url);
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[WS] Соединение установлено");
      setConnected(true);
      delayRef.current = INITIAL_RECONNECT_DELAY;
    };

    ws.onclose = (e) => {
      console.log("[WS] Закрыто:", e.code, e.reason);
      setConnected(false);
      wsRef.current = null;

      // Код 4001/4002 — серверный отказ, реконнект бесполезен
      if (e.code === 4001 || e.code === 4002) {
        onDisconnectRef.current?.(e.code, e.reason);
        return;
      }

      if (!intentionalClose.current && paramsRef.current) {
        const delay = delayRef.current;
        delayRef.current = Math.min(delay * 2, MAX_RECONNECT_DELAY);
        console.log(`[WS] Реконнект через ${delay}мс...`);
        reconnectTimer.current = setTimeout(() => {
          const p = paramsRef.current;
          if (p) doConnect(p.sessionKey, p.clientId);
        }, delay);
      }
    };

    ws.onerror = () => {};

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      // Серверный keepalive ping → отвечаем pong
      if (data.type === "ping") {
        rawSend({ type: "pong" });
        return;
      }

      onMessageRef.current?.(data);
    };
  }, [rawSend]);

  const connect = useCallback((sessionKey, clientId) => {
    doConnect(sessionKey, clientId);
  }, [doConnect]);

  const send = useCallback((data) => {
    rawSend(data);
  }, [rawSend]);

  const setOnMessage = useCallback((handler) => {
    onMessageRef.current = handler;
  }, []);

  const setOnDisconnect = useCallback((handler) => {
    onDisconnectRef.current = handler;
  }, []);

  const disconnect = useCallback(() => {
    intentionalClose.current = true;
    paramsRef.current = null;
    clearTimeout(reconnectTimer.current);
    wsRef.current?.close();
    wsRef.current = null;
    setConnected(false);
  }, []);

  return { connect, send, setOnMessage, setOnDisconnect, disconnect, connected };
}
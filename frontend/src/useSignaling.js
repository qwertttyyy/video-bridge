import { useRef, useCallback, useState } from "react";

const MAX_RECONNECT_DELAY = 8000;
const INITIAL_RECONNECT_DELAY = 500;

/**
 * WebSocket-сигналинг с автореконнектом.
 *
 * При обрыве соединения переподключается с exponential backoff.
 * Ручной disconnect() (кнопка «Завершить») отключает реконнект.
 */
export function useSignaling() {
  const wsRef = useRef(null);
  const onMessageRef = useRef(null);
  const paramsRef = useRef(null);
  const intentionalClose = useRef(false);
  const reconnectTimer = useRef(null);
  const delayRef = useRef(INITIAL_RECONNECT_DELAY);

  const [connected, setConnected] = useState(false);

  const doConnect = useCallback((sessionKey, clientId) => {
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
      onMessageRef.current?.(data);
    };
  }, []);

  const connect = useCallback((sessionKey, clientId) => {
    doConnect(sessionKey, clientId);
  }, [doConnect]);

  const send = useCallback((data) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }, []);

  const setOnMessage = useCallback((handler) => {
    onMessageRef.current = handler;
  }, []);

  const disconnect = useCallback(() => {
    intentionalClose.current = true;
    paramsRef.current = null;
    clearTimeout(reconnectTimer.current);
    wsRef.current?.close();
  }, []);

  return { connect, send, setOnMessage, disconnect, connected };
}

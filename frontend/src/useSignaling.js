import { useRef, useCallback, useState } from "react";
import { log } from "./logger";

const MAX_RECONNECT_DELAY = 8000;
const INITIAL_RECONNECT_DELAY = 500;

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
      if (data.type !== "pong") log.ws("→", data.type);
      return true;
    }
    log.warn("send пропущен, WS не OPEN:", data.type);
    return false;
  }, []);

  const doConnect = useCallback((sessionKey, clientId) => {
    if (wsRef.current) {
      intentionalClose.current = true;
      wsRef.current.close();
    }

    intentionalClose.current = false;
    paramsRef.current = { sessionKey, clientId };

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${window.location.host}/ws/${sessionKey}/${clientId}`;

    log.ws("подключаюсь:", url);
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      log.ws("open, clientId=", clientId);
      setConnected(true);
      delayRef.current = INITIAL_RECONNECT_DELAY;
    };

    ws.onclose = (e) => {
      log.ws("close code=", e.code, "reason=", e.reason || "—");
      setConnected(false);
      wsRef.current = null;

      if (e.code === 4001 || e.code === 4002) {
        onDisconnectRef.current?.(e.code, e.reason);
        return;
      }

      if (!intentionalClose.current && paramsRef.current) {
        const base = delayRef.current;
        delayRef.current = Math.min(base * 2, MAX_RECONNECT_DELAY);
        const jitter = 1 + (Math.random() * 0.6 - 0.3);
        const delay = Math.floor(base * jitter);
        log.ws(`реконнект через ${delay}мс`);
        reconnectTimer.current = setTimeout(() => {
          const p = paramsRef.current;
          if (p) doConnect(p.sessionKey, p.clientId);
        }, delay);
      }
    };

    ws.onerror = (e) => log.warn("WS error", e);

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
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

  const send = useCallback((data) => { rawSend(data); }, [rawSend]);

  const setOnMessage = useCallback((h) => { onMessageRef.current = h; }, []);
  const setOnDisconnect = useCallback((h) => { onDisconnectRef.current = h; }, []);

  const disconnect = useCallback(() => {
    log.ws("disconnect (intentional)");
    intentionalClose.current = true;
    paramsRef.current = null;
    clearTimeout(reconnectTimer.current);
    wsRef.current?.close();
    wsRef.current = null;
    setConnected(false);
  }, []);

  return { connect, send, setOnMessage, setOnDisconnect, disconnect, connected };
}
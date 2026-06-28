import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSignaling } from "./useSignaling";


class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.sent = [];
    MockWebSocket.instances.push(this);
  }

  send(payload) {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error("socket is not open");
    }
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.readyState = MockWebSocket.CLOSING;
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  emitClose(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  receive(data) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}


describe("useSignaling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("responds to server ping with pong", () => {
    const { result } = renderHook(() => useSignaling());

    act(() => result.current.connect("room1", "client1"));
    const ws = MockWebSocket.instances[0];
    act(() => ws.open());
    act(() => ws.receive({ type: "ping" }));

    expect(ws.sent).toContainEqual({ type: "pong" });
  });

  it("queues important messages until the socket opens", () => {
    const { result } = renderHook(() => useSignaling());

    act(() => result.current.connect("room1", "client1"));
    const ws = MockWebSocket.instances[0];

    let sent;
    act(() => {
      sent = result.current.send({ type: "media-state", camera: false, mic: true });
    });
    expect(sent).toBe(false);
    expect(ws.sent).toEqual([]);

    act(() => ws.open());

    expect(ws.sent).toEqual([{ type: "media-state", camera: false, mic: true }]);
  });

  it("keeps only the latest queued media-state", () => {
    const { result } = renderHook(() => useSignaling());

    act(() => result.current.connect("room1", "client1"));
    const ws = MockWebSocket.instances[0];

    act(() => {
      result.current.send({ type: "media-state", camera: false, mic: true });
      result.current.send({ type: "media-state", camera: true, mic: false });
    });
    act(() => ws.open());

    expect(ws.sent).toEqual([{ type: "media-state", camera: true, mic: false }]);
  });

  it("ignores close events from stale sockets after reconnect", () => {
    const { result } = renderHook(() => useSignaling());

    act(() => result.current.connect("room1", "client1"));
    const oldWs = MockWebSocket.instances[0];
    act(() => oldWs.open());
    expect(result.current.connected).toBe(true);

    act(() => result.current.connect("room1", "client1"));
    const newWs = MockWebSocket.instances[1];
    act(() => oldWs.emitClose(1006, ""));
    act(() => newWs.open());

    expect(result.current.connected).toBe(true);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("reports fatal server close codes and does not reconnect", () => {
    const { result } = renderHook(() => useSignaling());
    const onDisconnect = vi.fn();

    act(() => result.current.setOnDisconnect(onDisconnect));
    act(() => result.current.connect("room1", "client1"));
    const ws = MockWebSocket.instances[0];
    act(() => ws.open());
    act(() => ws.emitClose(4001, "Session is full"));
    act(() => vi.runOnlyPendingTimers());

    expect(onDisconnect).toHaveBeenCalledWith(4001, "Session is full");
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("reconnects after a non-fatal close", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { result } = renderHook(() => useSignaling());

    act(() => result.current.connect("room1", "client1"));
    const ws = MockWebSocket.instances[0];
    act(() => ws.open());
    act(() => ws.emitClose(1006, ""));
    act(() => vi.advanceTimersByTime(500));

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toContain("/ws/room1/client1");
  });

  it("ignores malformed server JSON without invoking the message handler", () => {
    const { result } = renderHook(() => useSignaling());
    const onMessage = vi.fn();

    act(() => result.current.setOnMessage(onMessage));
    act(() => result.current.connect("room1", "client1"));
    const ws = MockWebSocket.instances[0];
    act(() => ws.open());
    act(() => ws.onmessage?.({ data: "not json" }));

    expect(onMessage).not.toHaveBeenCalled();
  });
});

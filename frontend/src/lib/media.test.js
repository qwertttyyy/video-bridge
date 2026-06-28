import { afterEach, describe, expect, it, vi } from "vitest";

import { stopStream, watchDeviceChanges } from "./media";


describe("media helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stops all stream tracks", () => {
    const stopA = vi.fn();
    const stopB = vi.fn();

    stopStream({
      getTracks: () => [{ stop: stopA }, { stop: stopB }],
    });

    expect(stopA).toHaveBeenCalledOnce();
    expect(stopB).toHaveBeenCalledOnce();
  });

  it("returns a noop unwatch when mediaDevices events are unavailable", () => {
    const original = navigator.mediaDevices;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: undefined,
    });

    const unwatch = watchDeviceChanges(() => {});
    expect(() => unwatch()).not.toThrow();

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: original,
    });
  });
});

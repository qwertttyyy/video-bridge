import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startScreenShare, stopScreenShare } from "./screenShare";


class MockMediaStream {
  constructor(tracks = []) {
    this.tracks = tracks;
  }

  getTracks() {
    return this.tracks;
  }

  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }

  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }
}


describe("screenShare helpers", () => {
  let originalMediaDevices;

  beforeEach(() => {
    originalMediaDevices = navigator.mediaDevices;
    vi.stubGlobal("MediaStream", MockMediaStream);
  });

  afterEach(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices,
    });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("replaces the outgoing video track with the display track", async () => {
    const screenVideoTrack = { kind: "video", stop: vi.fn() };
    const micTrack = { kind: "audio", stop: vi.fn() };
    const replaceTrack = vi.fn();
    const screenStream = new MockMediaStream([screenVideoTrack]);
    const cameraStream = new MockMediaStream([micTrack]);

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getDisplayMedia: vi.fn(async () => screenStream),
      },
    });

    const result = await startScreenShare(
      { getSenders: () => [{ track: { kind: "video" }, replaceTrack }] },
      cameraStream,
    );

    expect(replaceTrack).toHaveBeenCalledWith(screenVideoTrack);
    expect(result.screenStream).toBe(screenStream);
    expect(result.displayStream.getTracks()).toEqual([screenVideoTrack, micTrack]);
    expect(result.audioMode).toBe("mic-only");
  });

  it("mixes screen audio with microphone and sends the mixed track", async () => {
    const screenVideoTrack = { kind: "video", stop: vi.fn() };
    const screenAudioTrack = { kind: "audio", stop: vi.fn() };
    const micTrack = { kind: "audio", stop: vi.fn() };
    const mixedTrack = { kind: "audio", stop: vi.fn() };
    const videoReplaceTrack = vi.fn();
    const audioReplaceTrack = vi.fn();
    const close = vi.fn();
    const connect = vi.fn();

    const screenStream = new MockMediaStream([screenVideoTrack, screenAudioTrack]);
    const cameraStream = new MockMediaStream([micTrack]);

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getDisplayMedia: vi.fn(async () => screenStream),
      },
    });

    vi.stubGlobal("AudioContext", class {
      resume = vi.fn(async () => {});
      close = close;
      createMediaStreamDestination = vi.fn(() => ({
        stream: new MockMediaStream([mixedTrack]),
      }));
      createMediaStreamSource = vi.fn(() => ({ connect }));
    });

    const result = await startScreenShare(
      {
        getSenders: () => [
          { track: { kind: "video" }, replaceTrack: videoReplaceTrack },
          { track: { kind: "audio" }, replaceTrack: audioReplaceTrack },
        ],
      },
      cameraStream,
    );

    expect(videoReplaceTrack).toHaveBeenCalledWith(screenVideoTrack);
    expect(audioReplaceTrack).toHaveBeenCalledWith(mixedTrack);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(result.audioMode).toBe("mixed");

    result.audioContext.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("falls back to screen audio when AudioContext is unavailable", async () => {
    const screenVideoTrack = { kind: "video", stop: vi.fn() };
    const screenAudioTrack = { kind: "audio", stop: vi.fn() };
    const micTrack = { kind: "audio", stop: vi.fn() };
    const videoReplaceTrack = vi.fn();
    const audioReplaceTrack = vi.fn();
    const screenStream = new MockMediaStream([screenVideoTrack, screenAudioTrack]);
    const cameraStream = new MockMediaStream([micTrack]);

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getDisplayMedia: vi.fn(async () => screenStream),
      },
    });
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);

    const result = await startScreenShare(
      {
        getSenders: () => [
          { track: { kind: "video" }, replaceTrack: videoReplaceTrack },
          { track: { kind: "audio" }, replaceTrack: audioReplaceTrack },
        ],
      },
      cameraStream,
    );

    expect(videoReplaceTrack).toHaveBeenCalledWith(screenVideoTrack);
    expect(audioReplaceTrack).toHaveBeenCalledWith(screenAudioTrack);
    expect(result.audioMode).toBe("screen-only");
  });

  it("restores camera and microphone tracks and stops screen tracks", async () => {
    const screenVideoTrack = { kind: "video", stop: vi.fn() };
    const mixedTrack = { kind: "audio", stop: vi.fn() };
    const cameraVideoTrack = { kind: "video", stop: vi.fn() };
    const micTrack = { kind: "audio", stop: vi.fn() };
    const videoReplaceTrack = vi.fn();
    const audioReplaceTrack = vi.fn();
    const close = vi.fn();

    await stopScreenShare(
      {
        getSenders: () => [
          { track: { kind: "video" }, replaceTrack: videoReplaceTrack },
          { track: { kind: "audio" }, replaceTrack: audioReplaceTrack },
        ],
      },
      new MockMediaStream([cameraVideoTrack, micTrack]),
      {
        screenStream: new MockMediaStream([screenVideoTrack]),
        mixedAudioTrack: mixedTrack,
        audioContext: { close },
      },
    );

    expect(screenVideoTrack.stop).toHaveBeenCalledOnce();
    expect(mixedTrack.stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(videoReplaceTrack).toHaveBeenCalledWith(cameraVideoTrack);
    expect(audioReplaceTrack).toHaveBeenCalledWith(micTrack);
  });
});

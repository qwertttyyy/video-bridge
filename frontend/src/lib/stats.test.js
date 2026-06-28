import { describe, expect, it } from "vitest";

import { getSelectedPair, qualityLevel } from "./stats";


describe("stats helpers", () => {
  it("prefers the explicitly selected ICE pair", async () => {
    const stats = new Map([
      ["transport", { type: "transport", selectedCandidatePairId: "pair-selected" }],
      [
        "pair-fallback",
        {
          id: "pair-fallback",
          type: "candidate-pair",
          nominated: true,
          state: "succeeded",
          localCandidateId: "local-host",
          remoteCandidateId: "remote-host",
          currentRoundTripTime: 0.25,
        },
      ],
      [
        "pair-selected",
        {
          id: "pair-selected",
          type: "candidate-pair",
          nominated: true,
          state: "succeeded",
          localCandidateId: "local-relay",
          remoteCandidateId: "remote-host",
          currentRoundTripTime: 0.05,
        },
      ],
      ["local-host", { id: "local-host", type: "local-candidate", candidateType: "host", protocol: "udp" }],
      ["local-relay", { id: "local-relay", type: "local-candidate", candidateType: "relay", protocol: "udp" }],
      ["remote-host", { id: "remote-host", type: "remote-candidate", candidateType: "host", protocol: "udp" }],
    ]);

    const pair = await getSelectedPair({
      connectionState: "connected",
      getStats: async () => stats,
    });

    expect(pair.rtt_ms).toBe(50);
    expect(pair.relayed).toBe(true);
    expect(pair.local.type).toBe("relay");
  });

  it("maps RTT to quality levels", () => {
    expect(qualityLevel(null)).toBe("unknown");
    expect(qualityLevel(50)).toBe("good");
    expect(qualityLevel(150)).toBe("ok");
    expect(qualityLevel(500)).toBe("poor");
  });
});

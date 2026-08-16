import { describe, expect, it } from "vitest";
import {
  createMarketFeedTelemetryRecorder,
  MARKET_FEED_TELEMETRY_VERSION,
} from "./market-feed-telemetry";

describe("market feed telemetry", () => {
  it("measures source age, receipt latency, and rolling update rate with an injected clock", () => {
    let now = 10_000;
    const recorder = createMarketFeedTelemetryRecorder({ freshnessMs: 5_000, now: () => now });
    recorder.recordStatus("live");
    recorder.recordAccepted({
      sourceTimestamp: 9_800,
      dataTimestamp: 9_800,
      componentTimestamps: { book: 9_800, trades: 9_900 },
    });
    now += 500;
    recorder.recordAccepted({
      sourceTimestamp: 10_300,
      dataTimestamp: 10_300,
      componentTimestamps: { book: 10_300, trades: 10_400 },
    });
    now += 500;
    recorder.recordAccepted({
      sourceTimestamp: 10_800,
      dataTimestamp: 10_800,
      componentTimestamps: { book: 10_800, trades: 10_900 },
    });

    expect(recorder.snapshot({ status: "live" })).toMatchObject({
      version: MARKET_FEED_TELEMETRY_VERSION,
      acceptedUpdateCount: 3,
      sourceAgeMs: 200,
      receiptLatencyMs: 200,
      componentAgesMs: { book: 200, trades: 100 },
      updateRateHz: 2,
      healthGrade: "A",
    });
  });

  it("bounds rolling samples/events while retaining saturating session counts", () => {
    let now = 20_000;
    const recorder = createMarketFeedTelemetryRecorder({
      freshnessMs: 5_000,
      now: () => now,
      sampleCapacity: 10,
    });
    for (let index = 0; index < 30; index += 1) {
      recorder.recordAccepted({ sourceTimestamp: now, dataTimestamp: now });
      recorder.recordReject("validation_gap");
      now += 100;
    }

    expect(recorder.snapshot()).toMatchObject({
      sampleCapacity: 10,
      rollingSampleCount: 10,
      rollingEventCount: 10,
      acceptedUpdateCount: 30,
      rejectedUpdateCount: 30,
      gapRejectCount: 30,
    });
  });

  it("counts transport transitions and regression classes and lets the rolling grade recover", () => {
    let now = 30_000;
    const recorder = createMarketFeedTelemetryRecorder({
      freshnessMs: 5_000,
      windowMs: 10_000,
      now: () => now,
    });
    recorder.recordStatus("live");
    recorder.recordAccepted({ sourceTimestamp: now, dataTimestamp: now });
    recorder.recordStatus("reconnecting");
    recorder.recordStatus("fallback_polling");
    recorder.recordStatus("stale");
    recorder.recordReject("sequence_regression");
    recorder.recordReject("timestamp_regression");

    expect(recorder.snapshot({ status: "stale", stale: true })).toMatchObject({
      reconnectCount: 1,
      fallbackCount: 1,
      staleCount: 1,
      sequenceRegressionCount: 1,
      timestampRegressionCount: 1,
      rejectedUpdateCount: 2,
      healthGrade: "F",
    });

    now += 10_001;
    recorder.recordStatus("live");
    recorder.recordAccepted({ sourceTimestamp: now, dataTimestamp: now });
    expect(recorder.snapshot({ status: "live" })).toMatchObject({
      rollingEventCount: 0,
      healthGrade: "A",
      reconnectCount: 1,
      fallbackCount: 1,
      staleCount: 1,
    });
  });
});

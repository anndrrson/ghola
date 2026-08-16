import { describe, expect, it } from "vitest";
import { buildGholaVolumeProfile } from "./ghola-volume-profile";
import type { GholaChartCandle } from "./ghola-market-chart";

describe("ghola volume profile", () => {
  it("finds POC and a contiguous 70% value area", () => {
    const profile = buildGholaVolumeProfile([
      candle("100", "101", "100", "101", "10"),
      candle("102", "102", "101", "101", "30"),
      candle("102", "103", "102", "103", "60"),
      candle("104", "104", "103", "103", "20"),
    ], 4);

    expect(profile?.totalVolume).toBeCloseTo(120);
    expect(profile?.bins.map((bin) => bin.volume)).toEqual([10, 30, 60, 20]);
    expect(profile?.pocIndex).toBe(2);
    expect(profile?.pocPrice).toBeCloseTo(102.5);
    expect(profile?.valueAreaLow).toBeCloseTo(101);
    expect(profile?.valueAreaHigh).toBeCloseTo(103);
    expect(profile?.valueAreaVolume).toBeCloseTo(90);
    expect(profile?.bins.map((bin) => bin.inValueArea)).toEqual([false, true, true, false]);
  });

  it("distributes a candle across every intersected price bin", () => {
    const profile = buildGholaVolumeProfile([candle("100", "104", "100", "104", "40")], 4);

    expect(profile?.bins.map((bin) => bin.volume)).toEqual([10, 10, 10, 10]);
    expect(profile?.bins.every((bin) => bin.buyVolume === 10 && bin.sellVolume === 0)).toBe(true);
  });

  it("keeps directional volume splits while conserving volume", () => {
    const profile = buildGholaVolumeProfile([
      candle("100", "102", "100", "102", "30"),
      candle("102", "102", "100", "100", "10"),
    ], 2);

    expect(profile?.totalVolume).toBeCloseTo(40);
    expect(profile?.bins.reduce((total, bin) => total + bin.buyVolume, 0)).toBeCloseTo(30);
    expect(profile?.bins.reduce((total, bin) => total + bin.sellVolume, 0)).toBeCloseTo(10);
  });

  it("ignores invalid samples and clamps configuration", () => {
    const invalid = candle("bad", "bad", "bad", "bad", "bad");
    expect(buildGholaVolumeProfile([invalid])).toBeNull();

    const profile = buildGholaVolumeProfile([candle("100", "101", "100", "101", "5")], 200, 5);
    expect(profile?.bins).toHaveLength(80);
    expect(profile?.valueAreaPct).toBe(1);
    expect(profile?.valueAreaVolume).toBeCloseTo(5);
  });
});

function candle(open: string, high: string, low: string, close: string, volume: string): GholaChartCandle {
  return { t: 1, T: 2, o: open, h: high, l: low, c: close, v: volume, n: 1 };
}

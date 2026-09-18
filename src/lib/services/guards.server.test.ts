import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { demoToolsEnabled, requireDemoMode } from "./guards.server";

let savedMode: string | undefined;
beforeEach(() => {
  savedMode = process.env["CHAIN_MODE"];
});
afterEach(() => {
  if (savedMode === undefined) delete process.env["CHAIN_MODE"];
  else process.env["CHAIN_MODE"] = savedMode;
});

describe("demoToolsEnabled", () => {
  it("is true only for an explicit or defaulted DEMO mode", () => {
    expect(demoToolsEnabled("DEMO")).toBe(true);
    expect(demoToolsEnabled("demo")).toBe(true);
    expect(demoToolsEnabled("")).toBe(true); // normalizeMode defaults to DEMO
    expect(demoToolsEnabled("TESTNET")).toBe(false);
    expect(demoToolsEnabled("MAINNET")).toBe(false);
  });
});

describe("requireDemoMode", () => {
  it("passes in DEMO", () => {
    process.env["CHAIN_MODE"] = "DEMO";
    expect(() => requireDemoMode()).not.toThrow();
  });

  it("throws in TESTNET — self-granted roles must not coexist with a possibly-live payout signer", () => {
    process.env["CHAIN_MODE"] = "TESTNET";
    expect(() => requireDemoMode()).toThrow(/only available in DEMO mode/);
  });

  it("throws in MAINNET", () => {
    process.env["CHAIN_MODE"] = "MAINNET";
    expect(() => requireDemoMode()).toThrow(/only available in DEMO mode/);
  });
});

import { randomBytes } from "node:crypto";
import { TronWeb } from "tronweb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KNOWN_NILE_USDT_CONTRACT } from "@/lib/providers/tron-testnet-signer.server";
import { MockEnergyRentalProvider } from "./mock-provider";
import { decideRentalProviderKind, resolveEnergyRentalProvider } from "./registry.server";
import { TronexEnergyRentalProvider } from "./tronex-provider.server";

const ENV_KEYS = [
  "CHAIN_MODE",
  "PAYOUT_SIGNER",
  "TRON_NETWORK",
  "CUSTODY_KEY_REF",
  "USDT_CONTRACT_ADDRESS",
  "TREASURY_ADDRESS",
  "TRON_API_URL",
  "TRONEX_API_KEY",
  "TRONEX_API_URL",
] as const;

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function setEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
}

const VALID_KEY = randomBytes(32).toString("hex");
const VALID_KEY_ADDRESS = new TronWeb({ fullHost: "https://nile.trongrid.io" }).address.fromPrivateKey(
  VALID_KEY,
) as string;

describe("resolveEnergyRentalProvider", () => {
  it("returns the Mock provider on Nile even with a real signer active and a rental API key configured", () => {
    setEnv({
      CHAIN_MODE: "TESTNET",
      PAYOUT_SIGNER: "TRON_TESTNET",
      TRON_NETWORK: "NILE",
      CUSTODY_KEY_REF: VALID_KEY,
      USDT_CONTRACT_ADDRESS: KNOWN_NILE_USDT_CONTRACT,
      TREASURY_ADDRESS: VALID_KEY_ADDRESS,
      TRONEX_API_KEY: "some-real-looking-key",
    });
    const provider = resolveEnergyRentalProvider();
    expect(provider).toBeInstanceOf(MockEnergyRentalProvider);
  });

  it("returns the Mock provider in DEMO mode", () => {
    setEnv({ CHAIN_MODE: "DEMO" });
    expect(resolveEnergyRentalProvider()).toBeInstanceOf(MockEnergyRentalProvider);
  });

  it("never returns the real Tronex adapter while TRON_NETWORK=NILE, regardless of TRONEX_API_KEY", () => {
    setEnv({
      CHAIN_MODE: "TESTNET",
      PAYOUT_SIGNER: "TRON_TESTNET",
      TRON_NETWORK: "NILE",
      CUSTODY_KEY_REF: VALID_KEY,
      USDT_CONTRACT_ADDRESS: KNOWN_NILE_USDT_CONTRACT,
      TREASURY_ADDRESS: VALID_KEY_ADDRESS,
      TRONEX_API_KEY: "irrelevant-because-nile",
    });
    expect(resolveEnergyRentalProvider()).not.toBeInstanceOf(TronexEnergyRentalProvider);
  });

  it("in this app's real config, TRON_NETWORK=MAINNET still resolves to Mock -- resolveRuntime's own gate never activates the real signer outside NILE, so it never reaches 'payout-signer-unavailable' being mistaken for a real marketplace call", () => {
    setEnv({
      CHAIN_MODE: "TESTNET",
      PAYOUT_SIGNER: "TRON_TESTNET",
      TRON_NETWORK: "MAINNET",
      CUSTODY_KEY_REF: VALID_KEY,
      USDT_CONTRACT_ADDRESS: KNOWN_NILE_USDT_CONTRACT,
      TREASURY_ADDRESS: VALID_KEY_ADDRESS,
    });
    // No TRONEX_API_KEY set either -- if the gate below were ever wrong, this
    // would throw ENERGY_RENTAL_UNAVAILABLE instead of quietly degrading.
    expect(() => resolveEnergyRentalProvider()).not.toThrow();
    expect(resolveEnergyRentalProvider()).toBeInstanceOf(MockEnergyRentalProvider);
  });
});

describe("decideRentalProviderKind — pure decision table", () => {
  it("chooses mock whenever the network isn't MAINNET, regardless of which provider is active or credentials", () => {
    expect(
      decideRentalProviderKind({ tronNetwork: "NILE", activePayoutProviderId: "tron-testnet-signer", hasApiKey: true }),
    ).toBe("mock");
    expect(
      decideRentalProviderKind({ tronNetwork: "", activePayoutProviderId: "mock-tron-testnet", hasApiKey: true }),
    ).toBe("mock");
  });

  it("chooses mock on MAINNET when the active provider is the blocked/unavailable stand-in, not the real signer -- this app's actual, only reachable MAINNET state", () => {
    expect(
      decideRentalProviderKind({
        tronNetwork: "MAINNET",
        activePayoutProviderId: "payout-signer-unavailable",
        hasApiKey: true,
      }),
    ).toBe("mock");
  });

  it("chooses mock on MAINNET when the active provider is the simulated mock signer too", () => {
    expect(
      decideRentalProviderKind({ tronNetwork: "MAINNET", activePayoutProviderId: "mock-tron-testnet", hasApiKey: true }),
    ).toBe("mock");
  });

  it("fails closed to missing-credentials on a real MAINNET marketplace call with no API key -- never silently degrades to burn pricing", () => {
    expect(
      decideRentalProviderKind({
        tronNetwork: "MAINNET",
        activePayoutProviderId: "tron-testnet-signer",
        hasApiKey: false,
      }),
    ).toBe("missing-credentials");
  });

  it("chooses real only when the real signer is genuinely active AND credentials are present", () => {
    expect(
      decideRentalProviderKind({
        tronNetwork: "MAINNET",
        activePayoutProviderId: "tron-testnet-signer",
        hasApiKey: true,
      }),
    ).toBe("real");
  });
});

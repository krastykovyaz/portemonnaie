/**
 * Chain mode configuration.
 *
 * DEMO    — fully simulated. No network calls, no keys, no value. Default.
 * TESTNET — talks to a real TRON testnet (Nile/Shasta) read API for payment
 *           detection. Payouts still require an explicitly configured signer.
 * MAINNET — refuses to run unless every guard rail is explicitly configured.
 */
export type ChainMode = "DEMO" | "TESTNET" | "MAINNET";

export const CHAIN_MODES: readonly ChainMode[] = ["DEMO", "TESTNET", "MAINNET"];

export function normalizeMode(raw: string | undefined | null): ChainMode {
  const value = (raw ?? "").trim().toUpperCase();
  if (value === "TESTNET") return "TESTNET";
  if (value === "MAINNET") return "MAINNET";
  return "DEMO";
}

export type ModeDescriptor = {
  mode: ChainMode;
  label: string;
  network: string;
  simulated: boolean;
  realValue: boolean;
  tone: "warning" | "info" | "danger";
  banner: string;
};

const DESCRIPTORS: Record<ChainMode, ModeDescriptor> = {
  DEMO: {
    mode: "DEMO",
    label: "DEMO / SIMULATED",
    network: "MOCK_CHAIN",
    simulated: true,
    realValue: false,
    tone: "warning",
    banner: "Simulated environment — no blockchain calls and no real value.",
  },
  TESTNET: {
    mode: "TESTNET",
    label: "TESTNET",
    network: "TRON_TESTNET",
    simulated: true,
    realValue: false,
    tone: "info",
    banner: "TRON testnet — test tokens only, never real value.",
  },
  MAINNET: {
    mode: "MAINNET",
    label: "MAINNET",
    network: "TRON_MAINNET",
    simulated: false,
    realValue: true,
    tone: "danger",
    banner: "MAINNET — real value moves. Every action is irreversible.",
  },
};

export function describeMode(mode: ChainMode): ModeDescriptor {
  return DESCRIPTORS[mode];
}

/** Browser-visible mode (never used for authorization decisions). */
export function clientMode(): ChainMode {
  return normalizeMode(import.meta.env["VITE_CHAIN_MODE"] as string | undefined);
}

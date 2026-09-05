import { describeMode, normalizeMode, type ChainMode, type ModeDescriptor } from "../config/mode";
import { mockPaymentGateway } from "./mock-payment-gateway";
import { TronPaymentGateway } from "./tron-payment-gateway";
import type { PaymentGateway } from "./payment-gateway";
import {
  ExternalCustodySigner,
  SimulatedWalletSigner,
  type WalletSigner,
} from "./wallet-signer";
import { blockchainProvider as mockBlockchainProvider } from "./mock-blockchain";
import { KNOWN_NILE_USDT_CONTRACT, TronTestnetPayoutSigner } from "./tron-testnet-signer.server";
import { UnavailablePayoutProvider } from "./unavailable-payout-provider";
import type { BlockchainProvider } from "./blockchain";

export type RuntimeConfig = {
  descriptor: ModeDescriptor;
  gateway: PaymentGateway;
  signer: WalletSigner;
  /** Real chain payout provider — see resolvePayoutProvider() below for the activation rules. */
  payoutProvider: BlockchainProvider;
  /** Non-empty only when PAYOUT_SIGNER=TRON_TESTNET was requested but config is invalid. */
  payoutBlockers: string[];
  requiredConfirmations: number;
  paymentTtlMinutes: number;
  /** Blocking problems that must be fixed before this mode can run. */
  blockers: string[];
};

const TESTNET_DEFAULT_API = "https://nile.trongrid.io";
const MAINNET_DEFAULT_API = "https://api.trongrid.io";

function num(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolve the payout (outgoing TRC20) provider.
 *
 * Activation requires an EXPLICIT opt-in: CHAIN_MODE=TESTNET alone is not
 * enough (that only ever enabled real payment *detection*). An operator must
 * also set PAYOUT_SIGNER=TRON_TESTNET. Without that, behavior is unchanged
 * from before this feature existed — simulated payouts, exactly like DEMO.
 *
 * Once opted in, every check below must pass or the provider is an
 * UnavailablePayoutProvider that fails loudly on every call. There is no
 * fallback to the mock here — a broken real-payout config must show up as a
 * failed/manual-review payout, never as a quietly-simulated one.
 *
 * MAINNET is completely out of scope for this provider: it always gets the
 * mock, same as DEMO. The MAINNET_ACKNOWLEDGED / CUSTODY_KEY_REF guard above
 * for the (currently unused) WalletSigner is untouched.
 */
function resolvePayoutProvider(mode: ChainMode): { provider: BlockchainProvider; blockers: string[] } {
  if (mode !== "TESTNET") {
    return { provider: mockBlockchainProvider, blockers: [] };
  }
  if ((process.env["PAYOUT_SIGNER"] ?? "").trim() !== "TRON_TESTNET") {
    return { provider: mockBlockchainProvider, blockers: [] };
  }

  const blockers: string[] = [];
  const tronNetwork = (process.env["TRON_NETWORK"] ?? "").trim().toUpperCase();
  if (tronNetwork !== "NILE") {
    blockers.push("TRON_NETWORK must be 'NILE' to enable the real testnet payout signer");
  }
  const custodyKeyRef = process.env["CUSTODY_KEY_REF"] ?? "";
  if (!custodyKeyRef.trim()) {
    blockers.push("CUSTODY_KEY_REF is not configured");
  }
  const contractAddress = process.env["USDT_CONTRACT_ADDRESS"] ?? "";
  if (contractAddress !== KNOWN_NILE_USDT_CONTRACT) {
    blockers.push(
      `USDT_CONTRACT_ADDRESS must be this project's known Nile testnet USDT contract (${KNOWN_NILE_USDT_CONTRACT})`,
    );
  }
  const apiUrl = process.env["TRON_API_URL"] ?? TESTNET_DEFAULT_API;
  if (!apiUrl.includes("nile")) {
    blockers.push("TRON_API_URL must point at a Nile testnet endpoint");
  }

  if (blockers.length > 0) {
    return { provider: new UnavailablePayoutProvider(blockers), blockers };
  }

  try {
    const provider = new TronTestnetPayoutSigner({
      privateKey: custodyKeyRef,
      apiUrl,
      apiKey: process.env["TRON_API_KEY"] ?? null,
      contractAddress,
      decimals: num(process.env["USDT_DECIMALS"], 6),
    });
    const treasuryAddress = process.env["TREASURY_ADDRESS"] ?? "";
    if (treasuryAddress && provider.custodyAddress !== treasuryAddress) {
      const mismatch = [
        `CUSTODY_KEY_REF derives ${provider.custodyAddress}, which does not match TREASURY_ADDRESS (${treasuryAddress}) — wrong key configured`,
      ];
      return { provider: new UnavailablePayoutProvider(mismatch), blockers: mismatch };
    }
    return { provider, blockers: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : "SIGNER_INIT_FAILED";
    return { provider: new UnavailablePayoutProvider([message]), blockers: [message] };
  }
}

/** Resolve the active runtime from server env. Call inside handlers only. */
export function resolveRuntime(): RuntimeConfig {
  const mode: ChainMode = normalizeMode(process.env["CHAIN_MODE"]);
  const descriptor = describeMode(mode);
  const requiredConfirmations = num(process.env["PAYMENT_CONFIRMATIONS"], 3);
  const paymentTtlMinutes = num(process.env["PAYMENT_TTL_MINUTES"], 30);
  const blockers: string[] = [];

  if (mode === "DEMO") {
    return {
      descriptor,
      gateway: mockPaymentGateway,
      signer: new SimulatedWalletSigner(),
      payoutProvider: mockBlockchainProvider,
      payoutBlockers: [],
      requiredConfirmations,
      paymentTtlMinutes,
      blockers,
    };
  }

  const contractAddress = process.env["USDT_CONTRACT_ADDRESS"] ?? "";
  const treasuryAddress = process.env["TREASURY_ADDRESS"] ?? "";
  if (!contractAddress) blockers.push("USDT_CONTRACT_ADDRESS is not configured");
  if (!treasuryAddress) blockers.push("TREASURY_ADDRESS is not configured");

  const signer =
    mode === "MAINNET"
      ? new ExternalCustodySigner(process.env["CUSTODY_KEY_REF"])
      : new SimulatedWalletSigner();
  if (mode === "MAINNET") {
    if (!signer.isConfigured()) blockers.push("CUSTODY_KEY_REF is not configured");
    if (process.env["MAINNET_ACKNOWLEDGED"] !== "true") {
      blockers.push("MAINNET_ACKNOWLEDGED must be set to 'true' to enable real value");
    }
  }

  const gateway =
    blockers.length > 0
      ? mockPaymentGateway
      : new TronPaymentGateway({
          mode,
          network: descriptor.network,
          apiBaseUrl:
            process.env["TRON_API_URL"] ??
            (mode === "MAINNET" ? MAINNET_DEFAULT_API : TESTNET_DEFAULT_API),
          apiKey: process.env["TRON_API_KEY"] ?? null,
          contractAddress,
          treasuryAddress,
          decimals: num(process.env["USDT_DECIMALS"], 6),
        });

  const { provider: payoutProvider, blockers: payoutBlockers } = resolvePayoutProvider(mode);

  return {
    descriptor,
    gateway,
    signer,
    payoutProvider,
    payoutBlockers,
    requiredConfirmations,
    paymentTtlMinutes,
    blockers,
  };
}

export function runtimeSummary() {
  const runtime = resolveRuntime();
  return {
    mode: runtime.descriptor.mode,
    label: runtime.descriptor.label,
    network: runtime.descriptor.network,
    banner: runtime.descriptor.banner,
    tone: runtime.descriptor.tone,
    simulated: runtime.descriptor.simulated,
    realValue: runtime.descriptor.realValue && runtime.blockers.length === 0,
    gateway: runtime.gateway.id,
    signer: runtime.signer.description,
    payoutProvider: runtime.payoutProvider.id,
    payoutSimulated: runtime.payoutProvider.simulated,
    payoutBlockers: runtime.payoutBlockers,
    requiredConfirmations: runtime.requiredConfirmations,
    paymentTtlMinutes: runtime.paymentTtlMinutes,
    blockers: runtime.blockers,
  };
}

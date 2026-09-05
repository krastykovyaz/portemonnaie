import { TronWeb } from "tronweb";
import { db, nowIso } from "@/lib/db/client";
import { REQUIRED_CONFIRMATIONS } from "../payout/state-machine";
import type { BlockchainProvider, ChainTransaction, ChainTxStatus, PayoutRequest } from "./blockchain";

const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

/**
 * This project's known Nile testnet USDT (TRC20) contract — the same one the
 * read-only payment gateway (tron-payment-gateway.ts) already trusts for
 * incoming-payment detection. The real payout signer refuses to run against
 * any other contract address, so a misconfigured USDT_CONTRACT_ADDRESS can
 * never silently point payouts at an unknown token.
 */
export const KNOWN_NILE_USDT_CONTRACT = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";

/** Minimum TRX (in sun) the custody wallet must hold to cover TRC20 transfer fees. */
const MIN_TRX_RESERVE_SUN = 5_000_000; // 5 TRX

export type TronTestnetSignerConfig = {
  /** Raw testnet private key, hex, no 0x prefix. NEVER a mainnet key — see registry validation. */
  privateKey: string;
  apiUrl: string;
  apiKey?: string | null;
  contractAddress: string;
  decimals?: number;
};

function holdingStatus(txHash: string, network: string): ChainTransaction {
  // "We broadcast this and genuinely don't know more yet" — never FAILED,
  // never null/unknown. Returning null here would tell the orchestrator the
  // provider has no record of the transaction, which triggers a RE-BROADCAST.
  // A transient TronGrid error or a not-yet-indexed transaction must never be
  // treated that way, or a network blip could cause a real double payout.
  return {
    txHash,
    status: "CONFIRMING",
    confirmations: 0,
    amount: 0,
    asset: "USDT",
    network,
    destinationAddress: "",
    createdAt: new Date().toISOString(),
  };
}

/**
 * Real TRON Nile testnet TRC20 USDT payout signer.
 *
 * Talks to the actual Nile testnet over TronGrid, signs with a testnet-only
 * custody key, and broadcasts real (but valueless) TRC20 transfers. Every
 * config value is validated in the constructor — construction throws rather
 * than producing a half-working instance, so callers (registry.server.ts)
 * can catch that and fail closed instead of silently falling back to a
 * simulated payout.
 */
export class TronTestnetPayoutSigner implements BlockchainProvider {
  readonly id = "tron-testnet-signer";
  readonly network = "TRON_TESTNET";
  readonly simulated = false;
  readonly custodyAddress: string;

  private readonly tronWeb: TronWeb;
  private readonly contractAddress: string;
  private readonly decimals: number;

  constructor(config: TronTestnetSignerConfig) {
    if (!config.apiUrl.includes("nile")) {
      throw new Error(
        "TRON_TESTNET_SIGNER_CONFIG: the RPC endpoint must be a Nile testnet host (got " +
          config.apiUrl +
          ")",
      );
    }
    if (config.contractAddress !== KNOWN_NILE_USDT_CONTRACT) {
      throw new Error(
        `TRON_TESTNET_SIGNER_CONFIG: USDT_CONTRACT_ADDRESS must be this project's known Nile testnet contract (${KNOWN_NILE_USDT_CONTRACT})`,
      );
    }
    const key = config.privateKey.trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error(
        "TRON_TESTNET_SIGNER_CONFIG: CUSTODY_KEY_REF is not a 32-byte hex private key",
      );
    }

    this.tronWeb = new TronWeb({
      fullHost: config.apiUrl,
      privateKey: key,
      ...(config.apiKey ? { headers: { "TRON-PRO-API-KEY": config.apiKey } } : {}),
    });

    const derived = this.tronWeb.address.fromPrivateKey(key);
    if (typeof derived !== "string" || !TRON_ADDRESS_RE.test(derived)) {
      throw new Error(
        "TRON_TESTNET_SIGNER_CONFIG: could not derive a valid TRON address from CUSTODY_KEY_REF",
      );
    }
    this.custodyAddress = derived;
    this.contractAddress = config.contractAddress;
    this.decimals = config.decimals ?? 6;
  }

  validateAddress(address: string): boolean {
    return TRON_ADDRESS_RE.test(address.trim());
  }

  async getBalance(asset: string): Promise<number> {
    if (asset !== "USDT") return 0;
    const contract = await this.tronWeb.contract().at(this.contractAddress);
    const raw = await contract["balanceOf"](this.custodyAddress).call({
      from: this.custodyAddress,
    });
    return Number(raw) / 10 ** this.decimals;
  }

  private async getTrxBalanceSun(): Promise<number> {
    return this.tronWeb.trx.getBalance(this.custodyAddress);
  }

  async createPayout(request: PayoutRequest): Promise<ChainTransaction> {
    const destination = request.destinationAddress.trim();
    if (!this.validateAddress(destination)) throw new Error("INVALID_ADDRESS");
    if (!(request.amount > 0)) throw new Error("INVALID_AMOUNT");

    // Crash-safe idempotency: if this key already broadcast a real tx (even
    // if the caller's own DB write never completed, e.g. a crash between
    // broadcast and `payouts.tx_hash` being persisted), return that same tx
    // instead of ever signing a second transfer for the same redemption.
    const existing = db
      .query(`SELECT tx_hash FROM payout_signer_broadcasts WHERE idempotency_key = ?`)
      .get(request.idempotencyKey) as { tx_hash: string } | null;
    if (existing) {
      return {
        txHash: existing.tx_hash,
        status: "BROADCAST",
        confirmations: 0,
        amount: request.amount,
        asset: request.asset,
        network: this.network,
        destinationAddress: destination,
        createdAt: nowIso(),
        deduplicated: true,
      };
    }

    const usdtBalance = await this.getBalance("USDT");
    if (usdtBalance < request.amount) {
      throw new Error(
        `INSUFFICIENT_USDT_BALANCE: treasury has ${usdtBalance} USDT, payout needs ${request.amount} USDT`,
      );
    }
    const trxBalanceSun = await this.getTrxBalanceSun();
    if (trxBalanceSun < MIN_TRX_RESERVE_SUN) {
      throw new Error(
        `INSUFFICIENT_TRX_BALANCE: treasury has ${trxBalanceSun / 1e6} TRX, needs at least ${
          MIN_TRX_RESERVE_SUN / 1e6
        } TRX reserved for transfer fees`,
      );
    }

    const amountUnits = Math.round(request.amount * 10 ** this.decimals);
    const contract = await this.tronWeb.contract().at(this.contractAddress);

    let txHash: unknown;
    try {
      txHash = await contract["transfer"](destination, amountUnits).send({
        feeLimit: 100_000_000,
        shouldPollResponse: false,
        from: this.custodyAddress,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`BROADCAST_FAILED: ${message}`);
    }
    if (typeof txHash !== "string" || !txHash) {
      throw new Error("BROADCAST_FAILED: provider returned no transaction id");
    }

    // Persist BEFORE returning, so a crash between here and the caller's own
    // `payouts.tx_hash` write is still recoverable without a re-broadcast.
    db.query(
      `INSERT INTO payout_signer_broadcasts (idempotency_key, provider, tx_hash, destination_address, amount, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(request.idempotencyKey, this.id, txHash, destination, request.amount, nowIso());

    return {
      txHash,
      status: "BROADCAST",
      confirmations: 0,
      amount: request.amount,
      asset: request.asset,
      network: this.network,
      destinationAddress: destination,
      createdAt: nowIso(),
    };
  }

  async getTransactionStatus(txHash: string): Promise<ChainTransaction | null> {
    let info: { id?: string; blockNumber?: number; blockTimeStamp?: number; receipt?: { result?: string } } | null;
    try {
      info = await this.tronWeb.trx.getTransactionInfo(txHash);
    } catch {
      return holdingStatus(txHash, this.network);
    }
    if (!info || !info.id || typeof info.blockNumber !== "number") {
      return holdingStatus(txHash, this.network);
    }

    let currentBlock: number;
    try {
      const block = await this.tronWeb.trx.getCurrentBlock();
      currentBlock = block.block_header.raw_data.number;
    } catch {
      return holdingStatus(txHash, this.network);
    }

    const confirmations = Math.max(0, currentBlock - info.blockNumber);
    const receiptResult = info.receipt?.result ?? "SUCCESS";
    const reverted = receiptResult !== "SUCCESS";
    const status: ChainTxStatus = reverted
      ? "FAILED"
      : confirmations >= REQUIRED_CONFIRMATIONS
        ? "CONFIRMED"
        : "CONFIRMING";

    return {
      txHash,
      status,
      confirmations,
      amount: 0,
      asset: "USDT",
      network: this.network,
      destinationAddress: "",
      createdAt: new Date(info.blockTimeStamp ?? Date.now()).toISOString(),
      ...(reverted ? { failureReason: `CONTRACT_${receiptResult}` } : {}),
    };
  }

  async getConfirmations(txHash: string): Promise<number> {
    const status = await this.getTransactionStatus(txHash);
    return status?.confirmations ?? 0;
  }
}

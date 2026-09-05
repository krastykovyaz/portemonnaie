import type { ChainMode } from "../config/mode";
import type { DepositAddress, IncomingTransfer, PaymentGateway } from "./payment-gateway";

const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

export type TronGatewayConfig = {
  mode: ChainMode;
  network: string;
  apiBaseUrl: string;
  apiKey?: string | null;
  contractAddress: string;
  treasuryAddress: string;
  decimals?: number;
};

type TrongridTrc20Response = {
  data?: Array<{
    transaction_id?: string;
    from?: string;
    to?: string;
    value?: string;
    block_timestamp?: number;
    token_info?: { address?: string; decimals?: number };
  }>;
};

/**
 * Read-only TRC-20 monitor backed by a TronGrid-compatible HTTP API.
 * It never holds keys and never broadcasts anything; payouts go through a
 * separate WalletSigner that must be configured explicitly.
 */
export class TronPaymentGateway implements PaymentGateway {
  readonly id: string;
  readonly mode: ChainMode;
  readonly network: string;
  readonly asset = "USDT";
  readonly contractAddress: string;
  readonly simulated: boolean;

  private readonly config: TronGatewayConfig;

  constructor(config: TronGatewayConfig) {
    this.config = config;
    this.mode = config.mode;
    this.network = config.network;
    this.contractAddress = config.contractAddress;
    this.simulated = config.mode !== "MAINNET";
    this.id = `tron-${config.network.toLowerCase()}`;
  }

  validateAddress(address: string): boolean {
    return TRON_ADDRESS_RE.test(address.trim());
  }

  async getDepositAddress(orderRef: string): Promise<DepositAddress> {
    return {
      address: this.config.treasuryAddress,
      network: this.network,
      asset: this.asset,
      contractAddress: this.contractAddress,
      memo: `Send the exact amount for ${orderRef}. Amount matching identifies your order.`,
    };
  }

  private async request(path: string): Promise<TrongridTrc20Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.config.apiKey) headers["TRON-PRO-API-KEY"] = this.config.apiKey;
    const response = await fetch(`${this.config.apiBaseUrl}${path}`, { headers });
    if (!response.ok) throw new Error(`TRON_API_${response.status}`);
    return (await response.json()) as TrongridTrc20Response;
  }

  async getIncomingTransfers(address: string): Promise<IncomingTransfer[]> {
    const decimals = this.config.decimals ?? 6;
    const payload = await this.request(
      `/v1/accounts/${address}/transactions/trc20?only_to=true&limit=50&contract_address=${this.contractAddress}`,
    );
    return (payload.data ?? [])
      .filter((row) => row.transaction_id && row.value)
      .map((row) => ({
        txHash: String(row.transaction_id),
        fromAddress: String(row.from ?? ""),
        toAddress: String(row.to ?? address),
        amount: Number(row.value) / 10 ** (row.token_info?.decimals ?? decimals),
        asset: this.asset,
        // TronGrid does not return confirmations for TRC-20 rows; block age is
        // used as a conservative proxy and re-checked on every sweep.
        confirmations: row.block_timestamp && Date.now() - row.block_timestamp > 9_000 ? 3 : 1,
        blockNumber: null,
        observedAt: new Date(row.block_timestamp ?? Date.now()).toISOString(),
      }));
  }

  async getConfirmations(txHash: string): Promise<number> {
    try {
      const response = await fetch(`${this.config.apiBaseUrl}/wallet/gettransactioninfobyid`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey ? { "TRON-PRO-API-KEY": this.config.apiKey } : {}),
        },
        body: JSON.stringify({ value: txHash }),
      });
      if (!response.ok) return 0;
      const info = (await response.json()) as { blockNumber?: number; receipt?: unknown };
      return info.blockNumber ? 3 : 0;
    } catch {
      return 0;
    }
  }

  async getBalance(_address: string): Promise<number> {
    // Balance reads are treasury-service concerns; the monitor stays read-light.
    return 0;
  }
}

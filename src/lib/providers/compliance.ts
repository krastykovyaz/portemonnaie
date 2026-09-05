/**
 * Interfaces for the regulated providers this platform must plug into later.
 * All implementations here are inert MOCKS for the DEMO: they never call an
 * external service, never approve or bypass anything, and are only used to keep
 * the integration seams explicit.
 */

export type KycStatus = "NOT_STARTED" | "PENDING" | "VERIFIED" | "REJECTED";

export interface KycProvider {
  readonly id: string;
  readonly simulated: boolean;
  getStatus(subjectRef: string): Promise<KycStatus>;
  startVerification(subjectRef: string): Promise<{ status: KycStatus; sessionRef: string }>;
}

export type ScreeningVerdict = {
  address: string;
  verdict: "UNKNOWN" | "CLEAR" | "REVIEW" | "BLOCKED";
  riskScore: number;
  provider: string;
};

export interface WalletScreeningProvider {
  readonly id: string;
  readonly simulated: boolean;
  screenAddress(address: string): Promise<ScreeningVerdict>;
}

export interface CustodyProvider {
  readonly id: string;
  readonly simulated: boolean;
  getAccountBalance(asset: string): Promise<number>;
  requestWithdrawal(input: {
    asset: string;
    amount: number;
    destinationAddress: string;
    reference: string;
  }): Promise<{ withdrawalRef: string; status: string }>;
}

export interface WebhookProcessor {
  readonly id: string;
  verifySignature(rawBody: string, signature: string | null): Promise<boolean>;
  handleEvent(event: unknown): Promise<void>;
}

export class MockKycProvider implements KycProvider {
  readonly id = "mock-kyc";
  readonly simulated = true;
  async getStatus(): Promise<KycStatus> {
    return "NOT_STARTED";
  }
  async startVerification(subjectRef: string) {
    return { status: "PENDING" as KycStatus, sessionRef: `mock-kyc-${subjectRef}` };
  }
}

export class MockWalletScreeningProvider implements WalletScreeningProvider {
  readonly id = "mock-screening";
  readonly simulated = true;
  async screenAddress(address: string): Promise<ScreeningVerdict> {
    // Demo stub: returns UNKNOWN so no compliance decision is ever implied.
    return { address, verdict: "UNKNOWN", riskScore: 0, provider: this.id };
  }
}

export class MockCustodyProvider implements CustodyProvider {
  readonly id = "mock-custody";
  readonly simulated = true;
  async getAccountBalance(asset: string) {
    return asset === "USDT" ? 250_000 : 0;
  }
  async requestWithdrawal(input: { reference: string }) {
    return { withdrawalRef: `mock-wd-${input.reference}`, status: "SIMULATED" };
  }
}

export const kycProvider: KycProvider = new MockKycProvider();
export const screeningProvider: WalletScreeningProvider = new MockWalletScreeningProvider();
export const custodyProvider: CustodyProvider = new MockCustodyProvider();

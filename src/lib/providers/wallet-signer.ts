/**
 * WalletSigner — the ONLY place allowed to know about signing material.
 *
 * Hard rules enforced here:
 *  - no private key is ever stored in the database
 *  - no key material is ever returned, logged, or serialized
 *  - the DEMO signer has no key at all
 *  - the external signer only ever holds a *reference* (KMS/HSM key id)
 */
export type SignRequest = {
  idempotencyKey: string;
  to: string;
  amount: number;
  asset: string;
  network: string;
  reference: string;
};

export type SignedTransfer = {
  /** Provider/broadcast handle — never raw signed bytes. */
  transactionId: string;
  signer: string;
  network: string;
};

export interface WalletSigner {
  readonly id: string;
  /** Redacted description safe for logs and admin UI. */
  readonly description: string;
  readonly custodial: boolean;
  isConfigured(): boolean;
  signAndBroadcast(request: SignRequest): Promise<SignedTransfer>;
}

/** DEMO signer — deliberately incapable of touching a real chain. */
export class SimulatedWalletSigner implements WalletSigner {
  readonly id = "simulated-signer";
  readonly description = "Simulated signer (no key material exists)";
  readonly custodial = false;

  isConfigured(): boolean {
    return true;
  }

  async signAndBroadcast(request: SignRequest): Promise<SignedTransfer> {
    return {
      transactionId: `sim_${request.idempotencyKey}`,
      signer: this.id,
      network: request.network,
    };
  }
}

/**
 * Placeholder for a real custody integration. It holds a key *reference* only
 * and refuses to operate unless that reference is configured out-of-band.
 */
export class ExternalCustodySigner implements WalletSigner {
  readonly id = "external-custody";
  readonly custodial = true;
  readonly description: string;
  private readonly keyRef: string | null;

  constructor(keyRef: string | null | undefined) {
    this.keyRef = keyRef && keyRef.trim() ? keyRef.trim() : null;
    this.description = this.keyRef
      ? `External custody signer (key ref ${this.keyRef.slice(0, 4)}••••)`
      : "External custody signer (not configured)";
  }

  isConfigured(): boolean {
    return this.keyRef !== null;
  }

  async signAndBroadcast(_request: SignRequest): Promise<SignedTransfer> {
    throw new Error(
      "SIGNER_NOT_IMPLEMENTED: connect a custody/CASP provider before moving real value",
    );
  }
}

/** Never let key-ish values reach logs. */
export function redactSecrets(value: string): string {
  return value.replace(/\b[0-9a-fA-F]{40,}\b/g, "«redacted»");
}

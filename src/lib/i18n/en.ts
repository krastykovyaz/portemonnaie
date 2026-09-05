export const en = {
  common: {
    appName: "VoucherRail",
    demoTestnet: "DEMO / TESTNET",
    buyVoucher: "Buy a voucher",
    staffSignIn: "Staff sign in",
    signOut: "Sign out",
    continue: "Continue",
    loading: "Loading…",
  },
  nav: {
    overview: "Overview",
    orders: "Orders",
    vouchers: "Vouchers",
    batches: "Batches",
    agents: "Agents",
    payouts: "Payouts",
    transactions: "Transactions",
    operations: "Operations",
    ledger: "Ledger",
    auditLog: "Audit log",
    accountRoles: "Account & roles",
    agentWorkspace: "Agent workspace",
  },
  landing: {
    heroTitle: "Prepaid crypto vouchers, redeemed in seconds.",
    heroDesc:
      "Agents sell fixed-denomination vouchers. Customers redeem them for a simulated USDT payout on a test network, with a double-entry ledger recording every movement.",
    heroDisclaimer: "No real money is moved. All transactions and TX hashes are simulated.",
    redeemTitle: "Redeem a voucher",
    redeemDesc: "Enter the voucher ID and secret code printed on the voucher, or scan its QR code.",
    voucherIdLabel: "Voucher ID",
    codeLabel: "Secret code",
  },
  auth: {
    signInTitle: "Staff sign in",
    signUpTitle: "Create demo account",
    disclaimer: "DEMO / TESTNET — no real funds",
    emailLabel: "Email",
    passwordLabel: "Password",
    working: "Working…",
    signIn: "Sign in",
    signUp: "Sign up",
    toggleToSignUp: "Need a demo account? Sign up",
    toggleToSignIn: "Already have an account? Sign in",
  },
  orderStatus: {
    amountDue: "Amount due",
    received: "Received",
    network: "Network",
    confirmations: "Confirmations",
    payTo: "Pay to",
    reservationExpires: "Reservation expires",
    shownOnce: "Shown once and never stored in plaintext. Redeem it on the redemption page.",
    openRedemption: "Open redemption page",
    demoToolsDesc: "Demo tools — simulate what the chain monitor would see.",
    payExact: "Pay exact amount",
    underpay: "Underpay 50%",
    overpay: "Overpay 10%",
    loadingOrder: "Loading order…",
    couldNotLoad: "Could not load this order.",
    orderNotFound: "Order not found.",
    voucherDelivered: (id: string) => `Voucher ${id} delivered`,
    notFoundWithId: (id: string) => `Order ${id} not found.`,
  },
  redeem: {
    demoBadge: "DEMO / TESTNET — simulated payout",
    title: "Redeem voucher",
    secretCodeLabel: "Secret code",
    checkVoucher: "Check voucher",
    checking: "Checking…",
    walletLabel: "Your wallet address",
    redeemBtn: "Redeem voucher",
    submitting: "Submitting…",
    payoutSimulated: "Payout simulated",
    amountLabel: "Amount",
    simulatedTxHash: "Simulated TX hash",
    simulatedNote: "This transaction is simulated. No blockchain transfer occurred.",
  },
  admin: {
    account: {
      title: "Account & demo tools",
      subtitle: "These self-service role tools exist only because this is a demo build.",
    },
    agents: {
      title: "Agents",
      subtitle: "Commission is calculated for reporting only — no payouts occur in this demo.",
    },
    audit: {
      title: "Audit log",
      subtitle:
        "Append-only. Written by database functions and server actions, never by the browser.",
    },
    batches: {
      title: "Voucher batches",
      subtitle:
        "Secret codes are shown once, right after generation — the database only keeps their hash.",
    },
    dashboard: {
      title: "Admin overview",
      subtitle: "Simulated USDT on TRON testnet. No real value moves in this system.",
    },
    ledger: {
      title: "Ledger & reconciliation",
      subtitle: "Every voucher sale and redemption posts a balanced journal. Debits must equal credits.",
    },
    ops: {
      title: "Operations",
      subtitle: "Manual reviews, treasury, reconciliation and delivery recovery.",
    },
    orders: {
      title: "Orders",
      subtitle: "Reservation → payment → atomic fulfilment → delivery. Every step is replay-safe.",
    },
    payouts: {
      title: "Payouts",
      subtitle:
        "Payout state is tracked separately from voucher state. A voucher only becomes REDEEMED after its payout is CONFIRMED.",
    },
    transactions: {
      title: "Simulated transactions",
      subtitle: "All TX hashes are generated locally. Nothing is broadcast to any blockchain.",
    },
    vouchers: {
      title: "Vouchers",
      subtitle: "Secret codes are never stored or shown — only their hashes live in the database.",
    },
  },
};

export type Dictionary = typeof en;

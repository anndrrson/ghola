declare const Buffer:
  | {
      from(input: string, encoding: string): { toString(encoding: string): string };
    }
  | undefined;

export interface RailgunPaymentPayload {
  tx_signature?: string | null;
  shielded_receipt_id?: string | null;
  proof_b64?: string | null;
  nullifier_hex?: string | null;
  request_hash?: string;
  extensions: {
    ghola?: {
      request_hash?: string;
    };
    railgun: RailgunPaymentEvidence;
  };
}

export interface RailgunPaymentEvidence {
  tx_hash: string;
  amount: number;
  destination: string;
  network: string;
  asset: string;
  broadcaster: string;
  relay_only: true;
  public_wallet_broadcast: false;
  proof_of_innocence_id: string;
  proof_of_innocence_passed: true;
}

export interface RailgunX402Proof {
  x402Version: '2';
  scheme: 'railgun_evm_shielded';
  network: string;
  payload: RailgunPaymentPayload;
}

export interface X402PaymentOption {
  scheme?: string;
  network?: string;
  maxAmountRequired?: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  payTo?: string;
  asset?: string;
  extra?: {
    payment_rail?: string;
    canonical_rail?: string;
    request_hash?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface X402PaymentRequirements {
  x402Version?: number;
  accepts: X402PaymentOption[];
}

export interface RailgunX402PaymentProvider {
  createPayment(option: X402PaymentOption): Promise<{ paymentHeader: string }>;
}

export interface FetchWithRailgunX402Options extends RequestInit {
  provider: RailgunX402PaymentProvider;
  rail?: 'railgun_evm_shielded' | 'private_shielded_auto';
}

export interface RailgunTokenRecipient {
  tokenAddress: string;
  amount: bigint;
  recipientAddress: string;
}

export interface RailgunFeeTokenDetails {
  tokenAddress: string;
  decimals: number;
}

export interface RailgunTransactionGasDetails {
  gasEstimate: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export interface RailgunSelectedBroadcaster {
  railgunAddress: string;
  tokenFee: {
    feesID: string;
  };
}

export interface RailgunPopulateTransactionResponse {
  transaction: {
    to: string;
    data: string;
  };
  nullifiers?: string[];
}

export interface RailgunBroadcasterTransaction {
  send(): Promise<string>;
}

export interface RailgunBroadcasterTransactionFactory {
  create(
    to: string,
    data: string,
    railgunAddress: string,
    feesId: string,
    chain: unknown,
    nullifiers: string[],
    overallBatchMinGasPrice: bigint,
    useRelayAdapt: boolean,
  ): Promise<RailgunBroadcasterTransaction>;
}

export interface RailgunBroadcasterClient {
  findBestBroadcaster(
    chain: unknown,
    feeTokenAddress: string,
    requireAvailability: boolean,
  ): Promise<RailgunSelectedBroadcaster | undefined>;
}

export interface RailgunSdkFacade {
  TXIDVersion: {
    V2_PoseidonMerkle: unknown;
  };
  gasEstimateForUnprovenTransfer(
    txidVersion: unknown,
    network: string,
    railgunWalletId: string,
    encryptionKey: string,
    memoText: string | undefined,
    erc20Recipients: RailgunTokenRecipient[],
    nftRecipients: unknown[],
    originalGasDetails: RailgunTransactionGasDetails,
    broadcasterFeeRecipient: RailgunTokenRecipient | undefined,
    sendWithPublicWallet: boolean,
  ): Promise<{ gasEstimate: bigint }>;
  generateTransferProof(
    txidVersion: unknown,
    network: string,
    railgunWalletId: string,
    encryptionKey: string,
    showSenderAddressToRecipient: boolean,
    memoText: string | undefined,
    erc20Recipients: RailgunTokenRecipient[],
    nftRecipients: unknown[],
    broadcasterFeeRecipient: RailgunTokenRecipient | undefined,
    sendWithPublicWallet: boolean,
    overallBatchMinGasPrice: bigint,
    progressCallback: (progress: number) => void,
  ): Promise<void>;
  populateProvedTransfer(
    txidVersion: unknown,
    network: string,
    railgunWalletId: string,
    showSenderAddressToRecipient: boolean,
    memoText: string | undefined,
    erc20Recipients: RailgunTokenRecipient[],
    nftRecipients: unknown[],
    broadcasterFeeRecipient: RailgunTokenRecipient | undefined,
    sendWithPublicWallet: boolean,
    overallBatchMinGasPrice: bigint,
    transactionGasDetails: RailgunTransactionGasDetails,
  ): Promise<RailgunPopulateTransactionResponse>;
  calculateGasPrice(gasDetails: RailgunTransactionGasDetails): bigint;
  calculateBroadcasterFeeERC20Amount(
    feeTokenDetails: RailgunFeeTokenDetails,
    estimatedGasDetails: RailgunTransactionGasDetails,
  ): { tokenAddress: string; amount: bigint };
}

export interface CreateRailgunX402PaymentOptions {
  sdk: RailgunSdkFacade;
  broadcasterClient: RailgunBroadcasterClient;
  broadcasterTransaction: RailgunBroadcasterTransactionFactory;
  chain: unknown;
  network: string;
  railgunWalletId: string;
  encryptionKey: string;
  tokenAddress: string;
  amount: bigint;
  asset: string;
  destinationRailgunAddress: string;
  feeTokenDetails: RailgunFeeTokenDetails;
  originalGasDetails: RailgunTransactionGasDetails;
  proofOfInnocenceId: string;
  requestHash?: string;
  relayOnly?: boolean;
  useRelayAdapt?: boolean;
  showSenderAddressToRecipient?: boolean;
  memoText?: string;
  onProofProgress?: (progress: number) => void;
}

export function encodeX402PaymentHeader(proof: RailgunX402Proof): string {
  const json = JSON.stringify(proof, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  if (typeof Buffer !== 'undefined' && Buffer) {
    return Buffer.from(json, 'utf8').toString('base64');
  }
  if (typeof btoa !== 'undefined') {
    return btoa(json);
  }
  throw new Error('No base64 encoder is available in this runtime');
}

function decodeBase64Json<T>(input: string): T {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  if (typeof Buffer !== 'undefined' && Buffer) {
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as T;
  }
  if (typeof atob !== 'undefined') {
    return JSON.parse(atob(padded)) as T;
  }
  throw new Error('No base64 decoder is available in this runtime');
}

function paymentRequiredHeader(res: Response): string | null {
  return res.headers.get('payment-required') || res.headers.get('x-payment-required');
}

async function paymentRequirements(res: Response): Promise<X402PaymentRequirements> {
  const header = paymentRequiredHeader(res);
  if (header) return decodeBase64Json<X402PaymentRequirements>(header);
  const body = await res.clone().json().catch(() => null);
  if (body?.payment_requirements) return body.payment_requirements as X402PaymentRequirements;
  throw new Error('Payment required, but no x402 payment requirements were returned.');
}

function selectRailgunOption(requirements: X402PaymentRequirements): X402PaymentOption {
  const selected = requirements.accepts.find(
    (candidate) =>
      candidate.scheme === 'railgun_evm_shielded' ||
      candidate.extra?.payment_rail === 'railgun_evm_shielded' ||
      candidate.extra?.canonical_rail === 'railgun_evm_shielded',
  );
  if (!selected) {
    throw new Error('Railgun/EVM settlement is not available for this request.');
  }
  return selected;
}

function replayableBody(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (
    typeof ReadableStream !== 'undefined' &&
    body instanceof ReadableStream
  ) {
    throw new Error('fetchWithRailgunX402 requires a replayable request body, not ReadableStream.');
  }
  return body;
}

function replayableInput(input: RequestInfo | URL): RequestInfo | URL {
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.clone();
  }
  return input;
}

function normalizedChatCompletionsMethod(method: string | undefined): 'POST' {
  const normalized = (method ?? 'POST').toUpperCase();
  if (normalized !== 'POST') {
    throw new Error(`Railgun x402 chat completions only supports POST, got ${normalized}`);
  }
  return 'POST';
}

export async function fetchWithRailgunX402(
  input: RequestInfo | URL,
  options: FetchWithRailgunX402Options,
): Promise<Response> {
  const { provider, rail = 'railgun_evm_shielded', headers, body, ...init } = options;
  const requestBody = replayableBody(body);
  const method = normalizedChatCompletionsMethod(init.method);
  const firstHeaders = new Headers(headers);
  firstHeaders.set('x-ghola-payment-rail', rail);
  const first = await fetch(replayableInput(input), {
    ...init,
    method,
    headers: firstHeaders,
    body: requestBody,
  });
  if (first.status !== 402) return first;

  const requirements = await paymentRequirements(first);
  const selected = selectRailgunOption(requirements);
  const requestHash = selected.extra?.request_hash;
  if (typeof requestHash !== 'string' || requestHash.length === 0) {
    throw new Error('Railgun/EVM settlement is missing a request_hash binding.');
  }

  const payment = await provider.createPayment(selected);
  const retryHeaders = new Headers(headers);
  retryHeaders.set('x-ghola-payment-rail', 'railgun_evm_shielded');
  retryHeaders.set('x402-payment', payment.paymentHeader);
  retryHeaders.set('payment-signature', payment.paymentHeader);
  return fetch(replayableInput(input), {
    ...init,
    method,
    headers: retryHeaders,
    body: requestBody,
  });
}

export async function createRailgunX402Payment(
  options: CreateRailgunX402PaymentOptions,
): Promise<{ proof: RailgunX402Proof; paymentHeader: string; txHash: string }> {
  if (!options.proofOfInnocenceId.trim()) {
    throw new Error('Railgun payment requires proofOfInnocenceId');
  }
  if (options.amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Railgun payment amount exceeds safe JSON integer range');
  }
  if (options.relayOnly === false) {
    throw new Error('Railgun x402 payments require relay-only broadcaster submission');
  }
  if (options.useRelayAdapt === false) {
    throw new Error('Railgun x402 payments require relay-adapt broadcaster submission');
  }

  const erc20Recipients: RailgunTokenRecipient[] = [
    {
      tokenAddress: options.tokenAddress,
      amount: options.amount,
      recipientAddress: options.destinationRailgunAddress,
    },
  ];
  const selectedBroadcaster = await options.broadcasterClient.findBestBroadcaster(
    options.chain,
    options.feeTokenDetails.tokenAddress,
    true,
  );
  if (!selectedBroadcaster) {
    throw new Error('No Railgun broadcaster is available for the selected fee token');
  }

  const estimatedGas = await options.sdk.gasEstimateForUnprovenTransfer(
    options.sdk.TXIDVersion.V2_PoseidonMerkle,
    options.network,
    options.railgunWalletId,
    options.encryptionKey,
    options.memoText,
    erc20Recipients,
    [],
    options.originalGasDetails,
    undefined,
    false,
  );
  const estimatedGasDetails = {
    ...options.originalGasDetails,
    gasEstimate: estimatedGas.gasEstimate,
  };
  const broadcasterFee = options.sdk.calculateBroadcasterFeeERC20Amount(
    options.feeTokenDetails,
    estimatedGasDetails,
  );
  const broadcasterFeeRecipient: RailgunTokenRecipient = {
    tokenAddress: broadcasterFee.tokenAddress,
    amount: broadcasterFee.amount,
    recipientAddress: selectedBroadcaster.railgunAddress,
  };
  const overallBatchMinGasPrice = options.sdk.calculateGasPrice(estimatedGasDetails);

  await options.sdk.generateTransferProof(
    options.sdk.TXIDVersion.V2_PoseidonMerkle,
    options.network,
    options.railgunWalletId,
    options.encryptionKey,
    options.showSenderAddressToRecipient ?? false,
    options.memoText,
    erc20Recipients,
    [],
    broadcasterFeeRecipient,
    false,
    overallBatchMinGasPrice,
    options.onProofProgress ?? (() => undefined),
  );

  const populated = await options.sdk.populateProvedTransfer(
    options.sdk.TXIDVersion.V2_PoseidonMerkle,
    options.network,
    options.railgunWalletId,
    options.showSenderAddressToRecipient ?? false,
    options.memoText,
    erc20Recipients,
    [],
    broadcasterFeeRecipient,
    false,
    overallBatchMinGasPrice,
    estimatedGasDetails,
  );
  const tx = await options.broadcasterTransaction.create(
    populated.transaction.to,
    populated.transaction.data,
    selectedBroadcaster.railgunAddress,
    selectedBroadcaster.tokenFee.feesID,
    options.chain,
    populated.nullifiers ?? [],
    overallBatchMinGasPrice,
    options.useRelayAdapt ?? true,
  );
  const txHash = await tx.send();
  const nullifier = populated.nullifiers?.[0] ?? txHash;
  const proof: RailgunX402Proof = {
    x402Version: '2',
    scheme: 'railgun_evm_shielded',
    network: options.network,
    payload: {
      tx_signature: null,
      shielded_receipt_id: txHash,
      proof_b64: null,
      nullifier_hex: nullifier,
      ...(options.requestHash ? { request_hash: options.requestHash } : {}),
      extensions: {
        ...(options.requestHash
          ? {
              ghola: {
                request_hash: options.requestHash,
              },
            }
          : {}),
        railgun: {
          tx_hash: txHash,
          amount: Number(options.amount),
          destination: options.destinationRailgunAddress,
          network: options.network,
          asset: options.asset,
          broadcaster: selectedBroadcaster.railgunAddress,
          relay_only: true,
          public_wallet_broadcast: false,
          proof_of_innocence_id: options.proofOfInnocenceId,
          proof_of_innocence_passed: true,
        },
      },
    },
  };

  return {
    proof,
    paymentHeader: encodeX402PaymentHeader(proof),
    txHash,
  };
}

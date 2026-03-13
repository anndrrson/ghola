export interface SAIDPayClientOptions {
  /** API key for authentication */
  apiKey?: string;
  /** Base URL for the SAID Cloud API (default: https://api.said.id) */
  baseUrl?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

export interface AgentWallet {
  id: string;
  label: string;
  index: number;
  solana_address: string;
  spending_policy: SpendingPolicy;
  created_at: string;
  active: boolean;
}

export interface SpendingPolicy {
  daily_limit_lamports?: number;
  daily_limit_usdc_micro?: number;
  per_tx_limit_lamports?: number;
  per_tx_limit_usdc_micro?: number;
  allowed_recipients: string[];
}

export interface Balances {
  sol: string;
  usdc: string;
}

export interface Addresses {
  solana: string;
}

export interface TransferRequest {
  to: string;
  amount: string;
  currency: 'sol' | 'usdc';
  agent?: string;
  memo?: string;
}

export interface TransferResult {
  signature: string;
  explorer_url: string;
}

export interface CreateAgentRequest {
  label: string;
  dailyUsdcLimit?: string;
  perTxUsdcLimit?: string;
  dailySolLimit?: string;
  perTxSolLimit?: string;
  allowedRecipients?: string[];
}

export interface PaymentTransaction {
  id: string;
  agent_id: string;
  agent_label: string;
  direction: 'send' | 'receive';
  currency: 'sol' | 'usdc';
  amount: number;
  recipient: string;
  sender: string;
  signature: string;
  memo?: string;
  status: 'pending' | 'confirmed' | 'failed';
  created_at: string;
}

export interface SpendingLimits {
  daily_sol_limit?: number;
  daily_sol_spent: number;
  daily_sol_remaining?: number;
  daily_usdc_limit?: number;
  daily_usdc_spent: number;
  daily_usdc_remaining?: number;
  per_tx_sol_limit?: number;
  per_tx_usdc_limit?: number;
}

export interface McpConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

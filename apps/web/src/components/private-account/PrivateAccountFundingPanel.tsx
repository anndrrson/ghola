"use client";

import { useEffect, useState } from "react";
import { Copy, ShieldCheck, UploadCloud } from "lucide-react";
import { useThumperAuth } from "@/lib/thumper-auth-context";
import {
  createPrivateAccountFundingInstruction,
  getPrivateAccountFundingStatus,
  importPrivateAccountFundingReceipt,
  refreshPrivateAccountFundingBatch,
  type PrivateAccountSafeInput,
} from "@/lib/private-account-client";

interface FundingInstructionSummary {
  funding_intent_id: string;
  shielded_destination?: string;
  status?: string;
}

interface FundingBatchSummary {
  status?: string;
  effective_anonymity_set?: number;
  required_anonymity_set?: number;
  timing_window_met?: boolean;
}

interface FundingStatusSummary {
  vault_ready?: boolean;
  instructions?: FundingInstructionSummary[];
  imports?: unknown[];
  batches?: FundingBatchSummary[];
}

export function PrivateAccountFundingPanel({
  queueId,
  onChanged,
}: {
  queueId?: string;
  onChanged?: () => void | Promise<void>;
}) {
  const auth = useThumperAuth();
  const [amountBucket, setAmountBucket] =
    useState<PrivateAccountSafeInput["amount_bucket"]>("25");
  const [assetBucket, setAssetBucket] =
    useState<PrivateAccountSafeInput["asset_bucket"]>("stablecoin");
  const [receiptId, setReceiptId] = useState("");
  const [status, setStatus] = useState<FundingStatusSummary | null>(null);
  const [instruction, setInstruction] = useState<FundingInstructionSummary | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!auth.authenticated) {
      setStatus(null);
      setInstruction(null);
      return;
    }
    void refreshStatus();
  }, [auth.authenticated]);

  async function refreshStatus() {
    try {
      setStatus(await getPrivateAccountFundingStatus());
    } catch {
      setStatus(null);
    }
  }

  async function createInstruction() {
    setWorking(true);
    setMessage(null);
    try {
      const body = await createPrivateAccountFundingInstruction({
        amount_bucket: amountBucket,
        asset_bucket: assetBucket,
      });
      setInstruction(body.instruction as FundingInstructionSummary);
      setMessage("Funding instruction created.");
      await refreshStatus();
      await onChanged?.();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not create funding instruction.");
    } finally {
      setWorking(false);
    }
  }

  async function importReceipt() {
    const fundingIntentId =
      instruction?.funding_intent_id ||
      status?.instructions?.find((item) => item.status === "pending")?.funding_intent_id;
    if (!fundingIntentId) {
      setMessage("Create a funding instruction first.");
      return;
    }
    setWorking(true);
    setMessage(null);
    try {
      await importPrivateAccountFundingReceipt({
        funding_intent_id: fundingIntentId,
        receipt_id: receiptId.trim(),
      });
      setReceiptId("");
      setMessage("Funding imported into the private vault.");
      await refreshStatus();
      await onChanged?.();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not import funding receipt.");
    } finally {
      setWorking(false);
    }
  }

  async function refreshBatch() {
    setWorking(true);
    setMessage(null);
    try {
      const body = await refreshPrivateAccountFundingBatch({ queue_id: queueId });
      setMessage(
        body.batch?.status === "evidence_ready"
          ? "Batch evidence is ready for Private Mode."
          : "Batch is still waiting for enough compatible imports.",
      );
      await refreshStatus();
      await onChanged?.();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not refresh funding batch.");
    } finally {
      setWorking(false);
    }
  }

  async function copyDestination() {
    const destination = instruction?.shielded_destination;
    if (!destination) return;
    try {
      await navigator.clipboard.writeText(destination);
      setMessage("Shielded destination copied.");
    } catch {
      setMessage(destination);
    }
  }

  const latestBatch = status?.batches?.[0];

  return (
    <div className="border border-[#1e2a3a] bg-[#0f1117] p-5">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-[#a8d8ff]" />
        <h2 className="text-lg font-medium">Private funding</h2>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Select
          label="Amount bucket"
          value={amountBucket}
          options={[["5", "$5"], ["10", "$10"], ["25", "$25"], ["50", "$50"], ["100", "$100"]]}
          onChange={(value) => setAmountBucket(value as PrivateAccountSafeInput["amount_bucket"])}
        />
        <Select
          label="Asset bucket"
          value={assetBucket}
          options={[["stablecoin", "Stablecoin"], ["SOL", "SOL"], ["ETH", "ETH"], ["BTC", "BTC"], ["major", "Major"], ["long_tail", "Long tail"]]}
          onChange={(value) => setAssetBucket(value as PrivateAccountSafeInput["asset_bucket"])}
        />
      </div>
      <button
        onClick={createInstruction}
        disabled={working || !auth.authenticated}
        className="mt-4 h-10 w-full bg-[#eef1f8] px-4 text-sm font-medium text-[#08090d] disabled:cursor-not-allowed disabled:opacity-50"
      >
        Create Shielded Funding Instruction
      </button>
      {instruction?.shielded_destination && (
        <div className="mt-3 border border-[#1e2a3a] bg-[#08090d] p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-[#6f7d9a]">Shielded destination</span>
            <button onClick={copyDestination} className="inline-flex items-center gap-1 text-xs text-[#a8d8ff]">
              <Copy className="h-3.5 w-3.5" />
              Copy
            </button>
          </div>
          <p className="mt-2 break-all font-mono text-xs text-[#eef1f8]">
            {instruction.shielded_destination}
          </p>
        </div>
      )}
      <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]">
        <input
          value={receiptId}
          onChange={(event) => setReceiptId(event.target.value)}
          placeholder="custom_receipt_..."
          className="h-10 border border-[#1e2a3a] bg-[#08090d] px-3 font-mono text-sm text-[#eef1f8] outline-none"
        />
        <button
          onClick={importReceipt}
          disabled={working || !receiptId.trim()}
          className="inline-flex h-10 items-center justify-center gap-2 border border-[#3da8ff]/30 bg-[#3da8ff]/10 px-4 text-sm font-medium text-[#a8d8ff] disabled:opacity-50"
        >
          <UploadCloud className="h-4 w-4" />
          Import
        </button>
      </div>
      <div className="mt-4 grid gap-2 text-xs text-[#8b95a8] sm:grid-cols-3">
        <Metric label="Vault" value={status?.vault_ready ? "ready" : "not ready"} />
        <Metric label="Imports" value={String(status?.imports?.length ?? 0)} />
        <Metric label="Batch" value={latestBatch?.status || "waiting"} />
      </div>
      <button
        onClick={refreshBatch}
        disabled={working || !auth.authenticated}
        className="mt-3 h-10 w-full border border-[#344155] px-4 text-sm text-[#aab5c8] disabled:opacity-50"
      >
        Refresh Batch Evidence
      </button>
      {latestBatch && (
        <p className="mt-3 text-xs text-[#6f7d9a]">
          {latestBatch.effective_anonymity_set}/{latestBatch.required_anonymity_set} compatible imports
          · timing {latestBatch.timing_window_met ? "met" : "waiting"}
        </p>
      )}
      {message && <p className="mt-3 text-sm text-[#aab5c8]">{message}</p>}
    </div>
  );
}

function Select({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: ReadonlyArray<readonly [string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs text-[#8b95a8]">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 border border-[#1e2a3a] bg-[#08090d] px-3 text-sm text-[#eef1f8]"
      >
        {options.map(([optionValue, text]) => (
          <option key={optionValue} value={optionValue}>{text}</option>
        ))}
      </select>
    </label>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-[#1e2a3a] bg-[#08090d] p-3">
      <p>{label}</p>
      <p className="mt-1 font-medium text-[#eef1f8]">{value.replaceAll("_", " ")}</p>
    </div>
  );
}

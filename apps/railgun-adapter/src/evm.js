export async function rpcCall(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params
    })
  });
  if (!res.ok) {
    throw new Error(`EVM RPC ${method} failed with HTTP ${res.status}`);
  }
  const body = await res.json();
  if (body.error) {
    throw new Error(`EVM RPC ${method} failed: ${body.error.message || JSON.stringify(body.error)}`);
  }
  return body.result;
}

export async function verifiedReceipt({ rpcUrl, txHash, minConfirmations, contractAddress }) {
  const receipt = await rpcCall(rpcUrl, "eth_getTransactionReceipt", [txHash]);
  if (!receipt) throw new Error("transaction receipt not found");
  if (receipt.status !== "0x1") throw new Error("transaction failed on-chain");

  const blockNumber = Number.parseInt(receipt.blockNumber, 16);
  if (!Number.isFinite(blockNumber)) throw new Error("transaction receipt missing blockNumber");
  const currentBlockHex = await rpcCall(rpcUrl, "eth_blockNumber", []);
  const currentBlock = Number.parseInt(currentBlockHex, 16);
  const confirmations = Math.max(0, currentBlock - blockNumber + 1);
  if (confirmations < minConfirmations) {
    throw new Error(`insufficient confirmations: ${confirmations} < ${minConfirmations}`);
  }

  if (contractAddress) {
    const touchesContract =
      receipt.to?.toLowerCase() === contractAddress ||
      receipt.logs?.some((log) => log.address?.toLowerCase() === contractAddress);
    if (!touchesContract) throw new Error("transaction does not touch configured Railgun contract");
  }

  if (!Array.isArray(receipt.logs) || receipt.logs.length === 0) {
    throw new Error("transaction receipt has no logs");
  }

  return { receipt, confirmations };
}

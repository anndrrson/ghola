use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Utc;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::config::Config;

const TOKEN_PROGRAM_ID: [u8; 32] = [
    0x06, 0xdd, 0xf6, 0xe1, 0xd7, 0x65, 0xa1, 0x93, 0xd9, 0xcb, 0xe1, 0x46, 0xce, 0xeb, 0x79, 0xac,
    0x1c, 0xb4, 0x85, 0xed, 0x5f, 0x5b, 0x37, 0x91, 0x3a, 0x8c, 0xf5, 0x85, 0x7e, 0xff, 0x00, 0xa9,
];
const ATA_PROGRAM_ID: [u8; 32] = [
    0x8c, 0x97, 0x25, 0x8f, 0x4e, 0x24, 0x89, 0xf1, 0xbb, 0x3d, 0x10, 0x29, 0x14, 0x8e, 0x0d, 0x83,
    0x0b, 0x5a, 0x13, 0x99, 0xda, 0xff, 0x10, 0x84, 0x04, 0x8e, 0x7b, 0xd8, 0xdb, 0xe9, 0xf8, 0x59,
];
const USDC_MINT_MAINNET: [u8; 32] = [
    0xc6, 0xfa, 0x7a, 0xf3, 0xbe, 0xdb, 0xad, 0x39, 0x22, 0x22, 0x76, 0x5e, 0x44, 0x70, 0x04, 0x64,
    0xe3, 0xdf, 0x71, 0x23, 0xc0, 0x81, 0x5f, 0x84, 0xf4, 0x6f, 0xb3, 0x50, 0x8e, 0x97, 0xf8, 0xa7,
];
const USDC_MINT_DEVNET: [u8; 32] = [
    0x3b, 0x44, 0x2c, 0xc7, 0x14, 0xf8, 0x4f, 0x7a, 0x4c, 0x3c, 0x09, 0x65, 0xf5, 0xc8, 0xac, 0x51,
    0xdb, 0x35, 0xd5, 0x73, 0x45, 0x6e, 0x6e, 0x52, 0xb7, 0x05, 0x2b, 0xe7, 0x57, 0x3b, 0x15, 0x7f,
];
const USDC_MINT_MAINNET_B58: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_MINT_DEVNET_B58: &str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

pub struct ParsedPayment {
    pub scheme: String,
    pub network: String,
    pub signature: String,
    pub from: String,
}

pub struct VerifiedPayment {
    pub signature: String,
}

pub fn parse_payment_header(payload_b64: &str) -> Option<ParsedPayment> {
    let decoded = STANDARD.decode(payload_b64).ok()?;
    let parsed: said_x402::X402PaymentPayload = serde_json::from_slice(&decoded).ok()?;

    let scheme = parsed.scheme.trim().to_ascii_lowercase();
    let network = parsed.network.trim().to_string();
    let signature = parsed.payload.signature.trim().to_string();
    let from = parsed.payload.from.trim().to_string();

    if scheme.is_empty() || network.is_empty() || signature.is_empty() || from.is_empty() {
        return None;
    }
    if !network.starts_with("solana:") {
        return None;
    }

    let decoded_sig = bs58::decode(&signature).into_vec().ok()?;
    if decoded_sig.len() != 64 {
        return None;
    }
    let decoded_from = bs58::decode(&from).into_vec().ok()?;
    if decoded_from.len() != 32 {
        return None;
    }

    Some(ParsedPayment {
        scheme,
        network,
        signature,
        from,
    })
}

pub async fn verify_onchain_payment(
    http: &reqwest::Client,
    config: &Config,
    payment: &ParsedPayment,
    required_amount_micro_usdc: i64,
) -> Result<VerifiedPayment, &'static str> {
    if payment.scheme != "exact" {
        return Err("x402_scheme_not_supported");
    }
    if !is_expected_network(&config.solana_rpc_url, &payment.network) {
        return Err("x402_network_mismatch");
    }

    let platform_wallet = config
        .escrow_wallet_address
        .as_deref()
        .ok_or("x402_escrow_wallet_missing")?;
    let platform_wallet_bytes = decode_pubkey(platform_wallet).ok_or("x402_bad_escrow_wallet")?;
    let expected_mint = usdc_mint_b58(&config.solana_rpc_url);
    let expected_ata = find_ata(
        &platform_wallet_bytes,
        usdc_mint_bytes(&config.solana_rpc_url),
    )
    .ok_or("x402_ata_derive_failed")?;
    let expected_ata_b58 = bs58::encode(expected_ata).into_string();

    let tx = rpc_get_transaction(http, config, &payment.signature)
        .await
        .map_err(|_| "x402_rpc_failed")?;
    if tx.is_null() {
        return Err("x402_tx_not_finalized");
    }
    if tx
        .get("meta")
        .and_then(|m| m.get("err"))
        .map(|e| !e.is_null())
        .unwrap_or(true)
    {
        return Err("x402_tx_failed");
    }

    let block_time = tx.get("blockTime").and_then(|v| v.as_i64());
    let now = Utc::now().timestamp();
    match block_time {
        Some(bt) if now - bt > config.x402_max_tx_age_secs.max(0) => return Err("x402_tx_too_old"),
        Some(_) => {}
        None => return Err("x402_tx_missing_block_time"),
    }

    let (paid_amount, authority) = extract_transfer_info(&tx, expected_mint, &expected_ata_b58)
        .ok_or("x402_transfer_not_found")?;
    if paid_amount < required_amount_micro_usdc {
        return Err("x402_amount_too_low");
    }
    if authority != payment.from {
        return Err("x402_sender_mismatch");
    }

    Ok(VerifiedPayment {
        signature: payment.signature.clone(),
    })
}

async fn rpc_get_transaction(
    http: &reqwest::Client,
    config: &Config,
    signature: &str,
) -> Result<Value, anyhow::Error> {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getTransaction",
        "params": [
            signature,
            {
                "encoding": "jsonParsed",
                "commitment": "finalized",
                "maxSupportedTransactionVersion": 0
            }
        ],
    });

    let resp: Value = http
        .post(&config.solana_rpc_url)
        .timeout(std::time::Duration::from_secs(
            config.x402_verify_timeout_secs.max(1),
        ))
        .json(&body)
        .send()
        .await?
        .json()
        .await?;

    if resp.get("error").is_some() {
        return Err(anyhow::anyhow!("solana rpc returned error"));
    }
    resp.get("result")
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("missing result"))
}

fn extract_transfer_info(
    tx_result: &Value,
    expected_mint: &str,
    expected_destination_ata: &str,
) -> Option<(i64, String)> {
    let mut instructions = Vec::new();
    if let Some(top) = tx_result
        .pointer("/transaction/message/instructions")
        .and_then(|v| v.as_array())
    {
        instructions.extend(top.iter());
    }
    if let Some(inner) = tx_result
        .pointer("/meta/innerInstructions")
        .and_then(|v| v.as_array())
    {
        for group in inner {
            if let Some(ixs) = group.get("instructions").and_then(|v| v.as_array()) {
                instructions.extend(ixs.iter());
            }
        }
    }

    for ix in instructions {
        let Some(parsed) = ix.get("parsed") else {
            continue;
        };
        let ix_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if ix_type != "transferChecked" {
            continue;
        }
        let Some(info) = parsed.get("info") else {
            continue;
        };
        let mint = info.get("mint").and_then(|v| v.as_str()).unwrap_or("");
        let destination = info
            .get("destination")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if mint != expected_mint || destination != expected_destination_ata {
            continue;
        }

        let amount = info
            .pointer("/tokenAmount/amount")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);
        let authority = info
            .get("authority")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        return Some((amount, authority));
    }

    None
}

fn is_expected_network(rpc_url: &str, network: &str) -> bool {
    if rpc_url.contains("devnet") {
        matches!(
            network,
            "solana:devnet" | "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
        )
    } else {
        matches!(
            network,
            "solana:mainnet" | "solana:mainnet-beta" | "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
        )
    }
}

fn usdc_mint_b58(rpc_url: &str) -> &'static str {
    if rpc_url.contains("devnet") {
        USDC_MINT_DEVNET_B58
    } else {
        USDC_MINT_MAINNET_B58
    }
}

fn usdc_mint_bytes(rpc_url: &str) -> &'static [u8; 32] {
    if rpc_url.contains("devnet") {
        &USDC_MINT_DEVNET
    } else {
        &USDC_MINT_MAINNET
    }
}

fn decode_pubkey(pubkey: &str) -> Option<[u8; 32]> {
    let bytes = bs58::decode(pubkey).into_vec().ok()?;
    bytes.try_into().ok()
}

fn find_ata(wallet: &[u8; 32], mint: &[u8; 32]) -> Option<[u8; 32]> {
    for bump in (0u8..=255).rev() {
        let mut hasher = Sha256::new();
        hasher.update(wallet);
        hasher.update(TOKEN_PROGRAM_ID);
        hasher.update(mint);
        hasher.update([bump]);
        hasher.update(ATA_PROGRAM_ID);
        hasher.update(b"ProgramDerivedAddress");
        let hash = hasher.finalize();
        let candidate: [u8; 32] = hash.into();
        if !is_on_curve(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn is_on_curve(bytes: &[u8; 32]) -> bool {
    use curve25519_dalek::edwards::CompressedEdwardsY;
    CompressedEdwardsY(*bytes).decompress().is_some()
}

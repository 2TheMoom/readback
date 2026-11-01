//! 1Click quote signatures.
//!
//! 1Click signs `base58(sha256(stable_json(signed_fields)))` with its manager key. The signed fields are the
//! ones the official SDK (`@defuse-protocol/one-click-sdk-typescript` 0.1.26, `quote-signature.ts`) selects;
//! notably `appFees` are never signed, and on dry quotes neither are the fees.
//! `serde_json::Map` is a BTreeMap here (no `preserve_order`), so serialising it gives sorted, compact JSON,
//! which matched the SDK on 2,000 fuzzed quotes in research/s7-fuzz.js.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// 1Click manager public key, from the official SDK source.
pub const ONE_CLICK_MANAGER_KEY: &str = "reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";

const REQ: [&str; 12] = ["dry", "swapType", "slippageTolerance", "originAsset", "depositType", "destinationAsset", "amount", "refundTo", "refundType", "recipient", "recipientType", "deadline"];
const REQ_OPT: [&str; 5] = ["quoteWaitingTimeMs", "referral", "virtualChainRecipient", "virtualChainRefundRecipient", "customRecipientMsg"];
const QUOTE: [&str; 8] = ["amountIn", "amountInFormatted", "amountInUsd", "minAmountIn", "amountOut", "amountOutFormatted", "amountOutUsd", "minAmountOut"];
const QUOTE_LIVE_OPT: [&str; 7] = ["depositAddress", "depositMemo", "deadline", "timeWhenInactive", "timeEstimate", "refundFee", "withdrawFee"];

/// JavaScript truthiness, to mirror the SDK's `x ? x : undefined`.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// The base58 quote hash 1Click signs, or `None` if the response is missing its parts.
pub fn quote_hash(resp: &Value) -> Option<String> {
    let req = resp.get("quoteRequest")?.as_object()?;
    let q = resp.get("quote")?.as_object()?;
    let ts = resp.get("timestamp")?;
    let mut m = Map::new();
    for k in REQ {
        if let Some(v) = req.get(k) {
            m.insert(k.into(), v.clone());
        }
    }
    for k in REQ_OPT {
        if let Some(v) = req.get(k).filter(|v| truthy(v)) {
            m.insert(k.into(), v.clone());
        }
    }
    for k in QUOTE {
        if let Some(v) = q.get(k) {
            m.insert(k.into(), v.clone());
        }
    }
    if !req.get("dry").is_some_and(truthy) {
        for k in QUOTE_LIVE_OPT {
            if let Some(v) = q.get(k).filter(|v| truthy(v)) {
                m.insert(k.into(), v.clone());
            }
        }
    }
    m.insert("timestamp".into(), ts.clone());
    let s = serde_json::to_string(&Value::Object(m)).ok()?;
    Some(bs58::encode(Sha256::digest(s.as_bytes())).into_string())
}

/// True only if `signature` is a valid ed25519 signature by the 1Click manager key over the quote hash.
pub fn signature_ok(resp: &Value, hash: &str) -> bool {
    let Some(sig) = resp.get("signature").and_then(Value::as_str) else { return false };
    let sig = sig.strip_prefix("ed25519:").unwrap_or(sig);
    let (Ok(sig), Ok(key)) = (bs58::decode(sig).into_vec(), bs58::decode(ONE_CLICK_MANAGER_KEY).into_vec()) else { return false };
    let (Ok(sig), Ok(key)) = (<[u8; 64]>::try_from(sig.as_slice()), <[u8; 32]>::try_from(key.as_slice())) else { return false };
    let Ok(vk) = VerifyingKey::from_bytes(&key) else { return false };
    vk.verify(hash.as_bytes(), &Signature::from_bytes(&sig)).is_ok()
}

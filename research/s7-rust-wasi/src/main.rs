// SPIKE 7 (throwaway, pre-hackathon research). Not product code. Never copied into the hackathon repo.
// Question: can Readback's core checks run as an OutLayer-style WASI module
// (JSON on stdin, compact JSON on stdout, output <= 900 bytes), and do they agree with the JS spikes?
use curve25519_dalek::edwards::CompressedEdwardsY;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};

const MANAGER: &str = "reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";
const REQ: [&str; 12] = ["dry", "swapType", "slippageTolerance", "originAsset", "depositType", "destinationAsset", "amount", "refundTo", "refundType", "recipient", "recipientType", "deadline"];
const REQ_OPT: [&str; 5] = ["quoteWaitingTimeMs", "referral", "virtualChainRecipient", "virtualChainRefundRecipient", "customRecipientMsg"];
const Q_DRY: [&str; 8] = ["amountIn", "amountInFormatted", "amountInUsd", "minAmountIn", "amountOut", "amountOutFormatted", "amountOutUsd", "minAmountOut"];
const Q_LIVE_OPT: [&str; 7] = ["depositAddress", "depositMemo", "deadline", "timeWhenInactive", "timeEstimate", "refundFee", "withdrawFee"];

// JavaScript truthiness, to mirror the SDK's `x ? x : undefined`
fn truthy(v: &Value) -> bool {
    match v { Value::Null => false, Value::Bool(b) => *b, Value::Number(n) => n.as_f64().map_or(false, |f| f != 0.0), Value::String(s) => !s.is_empty(), _ => true }
}

// base58(sha256(stable JSON)). serde_json's Map is a BTreeMap here, so keys serialize sorted and compact.
fn quote_hash(resp: &Value) -> Option<String> {
    let req = resp.get("quoteRequest")?; let q = resp.get("quote")?; let ts = resp.get("timestamp")?;
    let mut m = Map::new();
    for k in REQ { if let Some(v) = req.get(k) { m.insert(k.into(), v.clone()); } }
    for k in REQ_OPT { if let Some(v) = req.get(k) { if truthy(v) { m.insert(k.into(), v.clone()); } } }
    for k in Q_DRY { if let Some(v) = q.get(k) { m.insert(k.into(), v.clone()); } }
    if !req.get("dry").map_or(false, truthy) { for k in Q_LIVE_OPT { if let Some(v) = q.get(k) { if truthy(v) { m.insert(k.into(), v.clone()); } } } }
    m.insert("timestamp".into(), ts.clone());
    let s = serde_json::to_string(&Value::Object(m)).ok()?;
    Some(bs58::encode(Sha256::digest(s.as_bytes())).into_string())
}

fn quote_sig_ok(resp: &Value, hash: &str) -> bool {
    let sig = match resp.get("signature").and_then(Value::as_str) { Some(s) => s.trim_start_matches("ed25519:"), None => return false };
    let (Ok(sb), Ok(pb)) = (bs58::decode(sig).into_vec(), bs58::decode(MANAGER).into_vec()) else { return false };
    let (Ok(sa), Ok(pa)) = (<[u8; 64]>::try_from(sb.as_slice()), <[u8; 32]>::try_from(pb.as_slice())) else { return false };
    let Ok(vk) = VerifyingKey::from_bytes(&pa) else { return false };
    vk.verify(hash.as_bytes(), &Signature::from_bytes(&sa)).is_ok()
}

// Strict: reject non-canonical y (>= p), then require point decompression to succeed.
fn on_curve(addr: &str) -> Option<bool> {
    let b = bs58::decode(addr).into_vec().ok()?; let a: [u8; 32] = b.try_into().ok()?;
    let mut y = a; y[31] &= 0x7f;
    let p: [u8; 32] = { let mut p = [0xffu8; 32]; p[0] = 0xed; p[31] = 0x7f; p };
    let canonical = (0..32).rev().find(|&i| y[i] != p[i]).map_or(false, |i| y[i] < p[i]);
    Some(canonical && CompressedEdwardsY(a).decompress().is_some())
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str { v.get(k).and_then(Value::as_str).unwrap_or("") }
fn has(list: &Value, x: &str) -> bool { list.as_array().map_or(false, |a| a.iter().any(|e| e.as_str() == Some(x))) }

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).ok();
    let out = match serde_json::from_str::<Value>(&input) { Ok(v) => run(&v), Err(_) => json!({"v": "REFUSED", "err": "bad input"}) };
    let text = out.to_string();
    let mut so = io::stdout(); so.write_all(text.as_bytes()).ok(); so.flush().ok();
}

fn run(inp: &Value) -> Value {
    let resp = &inp["quote"]; let m = &inp["mandate"]; let req = &resp["quoteRequest"]; let q = &resp["quote"];
    let mut c = Map::new();
    let mut put = |k: &str, st: &str| { c.insert(k.into(), Value::from(st)); };

    let hash = quote_hash(resp).unwrap_or_default();
    put("quote_sig", if !hash.is_empty() && quote_sig_ok(resp, &hash) { "ok" } else { "bad" });

    let rcpt = s(req, "recipient");
    let payees: Vec<&str> = m["payees"].as_array().map(|a| a.iter().filter(|p| s(p, "chain") == s(m, "dest_chain")).map(|p| s(p, "address")).collect()).unwrap_or_default();
    let is_payee = payees.iter().any(|p| *p == rcpt);
    put("payee", if is_payee { "ok" } else { "bad" });
    // Compare by characters, never byte offsets: a hostile recipient with multi-byte characters must not panic.
    let pre = |x: &str, n: usize| x.chars().take(n).collect::<String>();
    let suf = |x: &str, n: usize| { let v: Vec<char> = x.chars().collect(); v[v.len().saturating_sub(n)..].iter().collect::<String>() };
    let look = !is_payee && payees.iter().any(|p| p.chars().count() >= 7 && rcpt.chars().count() >= 7 && pre(p, 4) == pre(rcpt, 4) && suf(p, 3) == suf(rcpt, 3));
    put("lookalike", if look { "bad" } else { "ok" });
    if s(m, "dest_chain") == "sol" { put("curve", match on_curve(rcpt) { Some(true) => "ok", Some(false) => "bad", None => "bad" }); }

    let amt: u128 = s(q, "amountIn").parse().unwrap_or(u128::MAX); let cap: u128 = s(m, "cap").parse().unwrap_or(0);
    put("amount", if amt <= cap { "ok" } else { "warn" });
    let slip = req["slippageTolerance"].as_u64().unwrap_or(u64::MAX); let max = m["max_slippage_bps"].as_u64().unwrap_or(0);
    put("slippage", if slip <= max { "ok" } else { "warn" });
    put("route", if has(&m["origin_assets"], s(req, "originAsset")) && has(&m["destination_assets"], s(req, "destinationAsset")) { "ok" } else { "bad" });
    put("refund", if has(&m["refund_to"], s(req, "refundTo")) { "ok" } else { "bad" });

    let v = if c.values().any(|x| x == "bad") { "REFUSED" } else if c.values().any(|x| x == "warn") { "HOLD" } else { "CLEARED" };
    json!({ "v": v, "c": c, "qh": hash })
}

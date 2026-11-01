//! The 16 checks and the verdict rule (docs/SPEC.md sections 5 and 12).
//!
//! Input contract (JSON):
//! - `kind`: `"quote"`, `"intent"` or `"destination"`
//! - quote / intent: `now` (UTC timestamp), `mandate`, `quote` (1Click quote response), optional `intent`
//!   (the `generate-intent` response), optional `tokens` (asset id -> {contractAddress}), optional `rpc`
//! - destination: `chain`, `address`, optional `token_contract`, optional `rpc`
//! - `rpc.sol_account`: two recorded answers (`null` = no account, `{owner, data_len}`, or `{error}`)
//! - `rpc.evm_code`: two `eth_getCode` answers (hex string, or `{error}`)
//! - `rpc.near_account`: two `view_account` answers (`null` = no account, `{code_hash}`, or `{error}`)
//!
//! A malformed or missing field never panics: it fails the check that needs it.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use crate::address::{self, Format};
use crate::quote;
use crate::time::parse_utc_ms;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Status {
    Ok,
    Warn,
    Error,
    Bad,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Ok => "ok",
            Status::Warn => "warn",
            Status::Error => "error",
            Status::Bad => "bad",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Cleared,
    Hold,
    Refused,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Cleared => "CLEARED",
            Verdict::Hold => "HOLD",
            Verdict::Refused => "REFUSED",
        }
    }
}

#[derive(Debug, Default)]
pub struct Outcome {
    pub checks: BTreeMap<&'static str, Status>,
    /// Short machine reason codes for checks that are not ok (for the sentence and notes).
    pub why: BTreeMap<&'static str, &'static str>,
    /// Set when the whole evaluation is refused before any check runs (`mandate_expired`, `bad_input`).
    pub error: Option<&'static str>,
    pub quote_hash: Option<String>,
}

impl Outcome {
    fn set(&mut self, check: &'static str, status: Status, why: &'static str) {
        self.checks.insert(check, status);
        if status != Status::Ok && !why.is_empty() {
            self.why.insert(check, why);
        }
    }

    /// Any bad gives REFUSED; else any warn or error gives HOLD; else CLEARED. An error never clears.
    pub fn verdict(&self) -> Verdict {
        if self.error.is_some() || self.checks.values().any(|s| *s == Status::Bad) {
            Verdict::Refused
        } else if self.checks.values().any(|s| matches!(s, Status::Warn | Status::Error)) {
            Verdict::Hold
        } else {
            Verdict::Cleared
        }
    }

    /// Compact output, well under OutLayer's 900-byte limit.
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("v".into(), json!(self.verdict().as_str()));
        o.insert("c".into(), Value::Object(self.checks.iter().map(|(k, s)| (k.to_string(), json!(s.as_str()))).collect()));
        if !self.why.is_empty() {
            o.insert("why".into(), Value::Object(self.why.iter().map(|(k, w)| (k.to_string(), json!(w))).collect()));
        }
        if let Some(e) = self.error {
            o.insert("err".into(), json!(e));
        }
        if let Some(h) = &self.quote_hash {
            o.insert("qh".into(), json!(h));
        }
        Value::Object(o)
    }
}

/// Intent types that are always refused: they hand over keys, authority or arbitrary calls.
const DENIED_INTENTS: [&str; 5] = ["add_public_key", "remove_public_key", "set_auth_by_predecessor_id", "auth_call", "imt_mint"];
/// Every intent type in the 1Click OpenAPI spec (research/s1-intent-schema.js). Anything else is refused.
const KNOWN_INTENTS: [&str; 13] = ["add_public_key", "remove_public_key", "transfer", "ft_withdraw", "nft_withdraw", "mt_withdraw", "native_withdraw", "storage_deposit", "token_diff", "set_auth_by_predecessor_id", "auth_call", "imt_mint", "imt_burn"];
const SPL_TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SPL_MINT_LEN: u64 = 82;

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// The account the money leaves from: the mandate's `spender` (an agent's own account), else its owner.
fn spender(m: &Value) -> &str {
    match s(m, "spender") {
        "" => s(m, "owner"),
        sp => sp,
    }
}

fn strings(v: &Value) -> Vec<&str> {
    v.as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default()
}

pub fn evaluate(input: &Value) -> Outcome {
    let mut out = Outcome::default();
    match s(input, "kind") {
        "destination" => destination(&mut out, s(input, "chain"), s(input, "address"), input.get("rpc"), input.get("token_contract").and_then(Value::as_str)),
        "quote" | "intent" => payment(&mut out, input),
        _ => out.error = Some("bad_input"),
    }
    out
}

/// format, then (only for a well-formed address) curve, mint, contract, tag.
fn destination(out: &mut Outcome, chain: &str, addr: &str, rpc: Option<&Value>, token_contract: Option<&str>) {
    match address::format(chain, addr) {
        Format::Bad => {
            out.set("format", Status::Bad, "malformed");
            return;
        }
        Format::OkNoChecksum => out.set("format", Status::Ok, ""),
        Format::Ok => out.set("format", Status::Ok, ""),
    }
    let rpc = rpc.cloned().unwrap_or(Value::Null);
    if chain == "sol" {
        let key = bs58::decode(addr).into_vec().unwrap_or_default();
        if address::on_curve(&key) {
            out.set("curve", Status::Ok, "");
        } else {
            out.set("curve", Status::Bad, "no_private_key");
        }
        let answers = rpc.get("sol_account").and_then(Value::as_array).cloned().unwrap_or_default();
        match agree(&answers, |v| v.get("error").is_some()) {
            None => out.set("mint", Status::Error, "rpc_unavailable_or_disagree"),
            Some(acc) => {
                let is_mint = s(&acc, "owner") == SPL_TOKEN_PROGRAM && acc.get("data_len").and_then(Value::as_u64) == Some(SPL_MINT_LEN);
                if is_mint {
                    out.set("mint", Status::Bad, "token_mint");
                } else {
                    out.set("mint", Status::Ok, "");
                }
            }
        }
    }
    if address::is_evm(chain) {
        let answers = rpc.get("evm_code").and_then(Value::as_array).cloned().unwrap_or_default();
        let lower: Vec<Value> = answers.iter().map(|v| v.as_str().map(|c| json!(c.to_ascii_lowercase())).unwrap_or_else(|| v.clone())).collect();
        match agree(&lower, |v| !v.is_string()) {
            None => out.set("contract", Status::Error, "rpc_unavailable_or_disagree"),
            Some(code) => match code.as_str().unwrap_or("") {
                "0x" => out.set("contract", Status::Ok, ""),
                c if c.starts_with("0xef0100") => out.set("contract", Status::Warn, "eip7702_delegated"),
                _ => out.set("contract", Status::Warn, "contract"),
            },
        }
        let is_token = token_contract.is_some_and(|t| t.eq_ignore_ascii_case(addr));
        if is_token {
            out.set("mint", Status::Bad, "token_contract");
        } else {
            out.set("mint", Status::Ok, "");
        }
    }
    if chain == "near" {
        near_destination(out, addr, &rpc, token_contract);
    }
    if chain == "xrp" {
        if address::xrp_x_address(addr) {
            out.set("tag", Status::Bad, "needs_destination_tag");
        } else {
            out.set("tag", Status::Ok, "");
        }
    }
}

const NO_CODE: &str = "11111111111111111111111111111111";

/// NEAR recipients. `curve`: someone can hold the key. For a 64-hex implicit account that means the bytes are an
/// ed25519 point (1Click quotes payouts to off-curve ids too); for a named account it means the account exists,
/// because a missing name can be registered later by anyone and claim what was sent. `contract`: the account
/// has code. `mint`: the recipient is the token's own contract.
fn near_destination(out: &mut Outcome, addr: &str, rpc: &Value, token_contract: Option<&str>) {
    let implicit = addr.len() == 64 && addr.bytes().all(|c| c.is_ascii_hexdigit());
    if implicit {
        let key: Vec<u8> = (0..32).filter_map(|i| u8::from_str_radix(&addr[2 * i..2 * i + 2], 16).ok()).collect();
        if key.len() == 32 && address::on_curve(&key) {
            out.set("curve", Status::Ok, "");
        } else {
            out.set("curve", Status::Bad, "no_private_key");
        }
    }
    let answers = rpc.get("near_account").and_then(Value::as_array).cloned().unwrap_or_default();
    match agree(&answers, |v| v.get("error").is_some()) {
        None => {
            out.set("contract", Status::Error, "rpc_unavailable_or_disagree");
            if !implicit {
                out.set("curve", Status::Error, "rpc_unavailable_or_disagree");
            }
        }
        Some(Value::Null) => {
            out.set("contract", Status::Ok, "");
            if !implicit {
                out.set("curve", Status::Bad, "account_does_not_exist");
            }
        }
        Some(acc) => {
            if !implicit {
                out.set("curve", Status::Ok, "");
            }
            if s(&acc, "code_hash") == NO_CODE {
                out.set("contract", Status::Ok, "");
            } else {
                out.set("contract", Status::Warn, "contract");
            }
        }
    }
    if token_contract.is_some_and(|t| t == addr) {
        out.set("mint", Status::Bad, "token_contract");
    } else {
        out.set("mint", Status::Ok, "");
    }
}

/// Edit distance, for names that are not hex: "alice.near" and "alise.near" are 1 apart.
fn edit_distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            cur[j + 1] = (prev[j] + usize::from(ca != cb)).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        prev = cur;
    }
    prev[b.len()]
}

/// Exactly two answers that both succeeded and agree; otherwise `None` (treated as error, never ok).
fn agree(answers: &[Value], failed: impl Fn(&Value) -> bool) -> Option<Value> {
    if answers.len() != 2 || answers.iter().any(&failed) || answers[0] != answers[1] {
        return None;
    }
    Some(answers[0].clone())
}

fn payment(out: &mut Outcome, input: &Value) {
    let m = input.get("mandate").cloned().unwrap_or(Value::Null);
    let resp = input.get("quote").cloned().unwrap_or(Value::Null);
    let (Some(now), Some(valid_until)) = (parse_utc_ms(s(input, "now")), parse_utc_ms(s(&m, "valid_until"))) else {
        out.error = Some("bad_input");
        return;
    };
    if now > valid_until {
        out.error = Some("mandate_expired");
        return;
    }
    let req = resp.get("quoteRequest").cloned().unwrap_or(Value::Null);
    let q = resp.get("quote").cloned().unwrap_or(Value::Null);

    // quote_sig
    let hash = quote::quote_hash(&resp);
    match &hash {
        Some(h) if quote::signature_ok(&resp, h) => out.set("quote_sig", Status::Ok, ""),
        _ => out.set("quote_sig", Status::Bad, "not_signed_by_1click"),
    }
    out.quote_hash = hash;

    // payee and lookalike
    let dest_chain = s(&m, "dest_chain");
    let evm = address::is_evm(dest_chain);
    let norm = |a: &str| if evm { a.to_ascii_lowercase() } else { a.to_string() };
    let recipient = s(&req, "recipient");
    let payees: Vec<String> = m.get("payees").and_then(Value::as_array).map(|a| a.iter().filter(|p| s(p, "chain") == dest_chain).map(|p| s(p, "address").to_string()).collect()).unwrap_or_default();
    let is_payee = payees.iter().any(|p| norm(p) == norm(recipient));
    if is_payee {
        out.set("payee", Status::Ok, "");
    } else {
        out.set("payee", Status::Bad, "not_a_saved_payee");
    }
    let hex64 = |x: &str| x.len() == 64 && x.bytes().all(|c| c.is_ascii_hexdigit());
    let looks_like = |p: &str| -> bool {
        // Every named NEAR account ends in the same suffix, so compare whole names by edit distance instead.
        if dest_chain == "near" && !hex64(p) && !hex64(recipient) {
            return edit_distance(p, recipient) <= 2;
        }
        let (a, b) = (norm(p), norm(recipient));
        let (a, b) = if evm { (a.trim_start_matches("0x").to_string(), b.trim_start_matches("0x").to_string()) } else { (a, b) };
        let (pre, post) = if evm { (4, 4) } else { (4, 3) };
        let (ac, bc): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
        ac.len() >= pre + post && bc.len() >= pre + post && ac[..pre] == bc[..pre] && ac[ac.len() - post..] == bc[bc.len() - post..]
    };
    if !is_payee && payees.iter().any(|p| looks_like(p)) {
        out.set("lookalike", Status::Bad, "lookalike_of_saved_payee");
    } else {
        out.set("lookalike", Status::Ok, "");
    }

    // destination checks on the recipient
    let token_contract = input.get("tokens").and_then(|t| t.get(s(&req, "destinationAsset"))).and_then(|t| t.get("contractAddress")).and_then(Value::as_str);
    destination(out, dest_chain, recipient, input.get("rpc"), token_contract);

    // amount and slippage
    let amount_in: Option<u128> = s(&q, "amountIn").parse().ok();
    let cap: Option<u128> = s(&m, "cap").parse().ok();
    match (amount_in, cap) {
        (Some(a), Some(c)) if a <= c => out.set("amount", Status::Ok, ""),
        (Some(_), Some(_)) => out.set("amount", Status::Warn, "over_cap"),
        _ => out.set("amount", Status::Error, "unreadable_amount"),
    }
    match (req.get("slippageTolerance").and_then(Value::as_f64), m.get("max_slippage_bps").and_then(Value::as_f64)) {
        (Some(sl), Some(max)) if sl <= max => out.set("slippage", Status::Ok, ""),
        (Some(_), Some(_)) => out.set("slippage", Status::Warn, "over_limit"),
        _ => out.set("slippage", Status::Error, "unreadable_slippage"),
    }

    // fees: only for same-value assets (v0.1), as a share of the amount
    if let Some(fees) = m.get("fees").filter(|f| f.get("same_value_assets").and_then(Value::as_bool) == Some(true)) {
        let max_pct = fees.get("max_pct").and_then(Value::as_f64).unwrap_or(5.0);
        let amt = s(&q, "amountIn").parse::<f64>().unwrap_or(0.0);
        let withdraw = s(&q, "withdrawFee").parse::<f64>().unwrap_or(0.0);
        let app_bps: f64 = req.get("appFees").and_then(Value::as_array).map(|a| a.iter().filter_map(|f| f.get("fee").and_then(Value::as_f64)).sum()).unwrap_or(0.0);
        if amt <= 0.0 {
            out.set("fees", Status::Error, "unreadable_amount");
        } else if (withdraw + amt * app_bps / 10_000.0) / amt * 100.0 > max_pct {
            out.set("fees", Status::Warn, "high_fees");
        } else {
            out.set("fees", Status::Ok, "");
        }
    }

    // route and refund
    let route_ok = strings(&m["origin_assets"]).contains(&s(&req, "originAsset")) && strings(&m["destination_assets"]).contains(&s(&req, "destinationAsset"));
    if !route_ok {
        out.set("route", Status::Bad, "asset_not_allowed");
    } else if s(&req, "recipientType") != "DESTINATION_CHAIN" {
        // INTENTS keeps the money inside intents.near under the recipient's name instead of paying it out; for
        // a NEAR name that does not exist yet, whoever registers the name later gets it.
        out.set("route", Status::Bad, "not_a_payout");
    } else {
        out.set("route", Status::Ok, "");
    }
    if strings(&m["refund_to"]).contains(&s(&req, "refundTo")) {
        out.set("refund", Status::Ok, "");
    } else {
        out.set("refund", Status::Bad, "refund_not_yours");
    }

    // timing: the quote response deadline when present (non-dry), else the requested one
    let deadline = parse_utc_ms(if s(&q, "deadline").is_empty() { s(&req, "deadline") } else { s(&q, "deadline") });
    let min_review_ms = m.get("min_review_seconds").and_then(Value::as_i64).unwrap_or(60) * 1000;
    match deadline {
        None => out.set("timing", Status::Error, "unreadable_deadline"),
        Some(d) if now > d => out.set("timing", Status::Bad, "expired"),
        Some(d) if d - now < min_review_ms => out.set("timing", Status::Warn, "too_short_to_review"),
        Some(_) => out.set("timing", Status::Ok, ""),
    }

    // intents and intent_binding
    if s(input, "kind") == "intent" {
        intent_checks(out, input.get("intent").unwrap_or(&Value::Null), &req, &q, &m);
    }
}

fn intent_checks(out: &mut Outcome, intent: &Value, req: &Value, q: &Value, m: &Value) {
    let payload = intent.get("intent").and_then(|i| i.get("payload")).cloned().unwrap_or(Value::Null);
    let msg: Value = serde_json::from_str(s(&payload, "message")).unwrap_or(Value::Null);
    let intents = msg.get("intents").and_then(Value::as_array).cloned().unwrap_or_default();
    let unsafe_kind = intents.iter().any(|i| {
        let k = s(i, "intent");
        DENIED_INTENTS.contains(&k) || !KNOWN_INTENTS.contains(&k)
    });
    if msg.is_null() || unsafe_kind {
        out.set("intents", Status::Bad, if msg.is_null() { "unreadable" } else { "unexpected_intent" });
    } else {
        out.set("intents", Status::Ok, "");
    }
    let bound = (|| -> Option<bool> {
        let t = intents.first()?;
        let tokens = t.get("tokens")?.as_object()?;
        let (asset, amount) = tokens.iter().next()?;
        Some(
            s(&payload, "recipient") == "intents.near"
                && intents.len() == 1
                && s(t, "intent") == "transfer"
                && !s(q, "depositAddress").is_empty()
                && s(t, "receiver_id") == s(q, "depositAddress")
                && tokens.len() == 1
                && asset == s(req, "originAsset")
                && amount.as_str() == Some(s(q, "amountIn"))
                && s(&msg, "signer_id") == spender(m)
                && s(&msg, "deadline") == s(q, "deadline"),
        )
    })()
    .unwrap_or(false);
    if bound {
        out.set("intent_binding", Status::Ok, "");
    } else {
        out.set("intent_binding", Status::Bad, "intent_does_not_match_quote");
    }
}

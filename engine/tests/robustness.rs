//! Hostile input: the engine must never panic, always return a verdict, and never CLEAR a quote whose
//! signed fields were changed. Deterministic (fixed seed) so failures reproduce.

use std::{fs, path::PathBuf};

use readback_engine::{evaluate, evaluate_str, Verdict};
use serde_json::{json, Value};

fn fixture(rel: &str) -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../docs/test-vectors").join(rel);
    serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap()
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[(self.next() % xs.len() as u64) as usize]
    }
}

fn weird(r: &mut Rng) -> Value {
    r.pick(&[
        json!(null), json!(true), json!(0), json!(-1), json!(1e308), json!(""), json!("x"), json!([]), json!({}),
        json!([1, 2]), json!({"a": 1}), json!("😀".repeat(40)), json!("a".repeat(5000)), json!("\u{0}\u{2028}\"\\"),
        json!("0x"), json!("ed25519:"), json!("2026-13-45T99:99:99Z"),
    ])
    .clone()
}

/// Fields 1Click signs (research/s3-quote-signature.js): changing any of them must break the signature.
const SIGNED: [&str; 10] = ["quoteRequest.recipient", "quoteRequest.refundTo", "quoteRequest.amount", "quoteRequest.deadline", "quoteRequest.originAsset", "quoteRequest.destinationAsset", "quote.amountIn", "quote.amountOut", "quote.minAmountOut", "timestamp"];
const ANY: [&str; 14] = ["quote", "mandate", "quote.quoteRequest", "quote.quote", "quote.signature", "quote.timestamp", "quote.quoteRequest.recipient", "quote.quoteRequest.slippageTolerance", "quote.quote.amountIn", "mandate.payees", "mandate.cap", "mandate.refund_to", "mandate.dest_chain", "rpc"];

fn set(root: &mut Value, path: &str, v: Value) {
    let parts: Vec<&str> = path.split('.').collect();
    let mut node = root;
    for p in &parts[..parts.len() - 1] {
        if !node.is_object() {
            return;
        }
        node = &mut node[*p];
    }
    if node.is_object() {
        node[parts[parts.len() - 1]] = v;
    }
}

fn base() -> Value {
    let v = fixture("vectors.json")["vectors"][0].clone();
    assert_eq!(v["id"], "V01");
    json!({
        "kind": "quote", "now": v["now"], "mandate": fixture("fixtures/mandates.json")["M1"],
        "quote": fixture("fixtures/quotes/Q_clean.json"), "rpc": v["rpc"],
    })
}

#[test]
fn base_is_cleared() {
    assert_eq!(evaluate(&base()).verdict(), Verdict::Cleared);
}

#[test]
fn malformed_input_never_panics_and_always_answers() {
    let mut r = Rng(0x5eed_cafe);
    for raw in ["", "null", "[]", "{", "{\"kind\":\"quote\"}", "garbage", "\u{0}", "{\"kind\":\"intent\",\"quote\":{},\"mandate\":{}}", "{\"kind\":\"destination\"}"] {
        let out = evaluate_str(raw);
        assert!(out.contains("\"v\":"), "no verdict for {raw:?}: {out}");
        assert!(!out.contains("CLEARED"), "cleared garbage {raw:?}");
    }
    for _ in 0..3000 {
        let mut input = base();
        for _ in 0..1 + r.next() % 3 {
            let path = *r.pick(&ANY);
            let value = weird(&mut r);
            set(&mut input, path, value);
        }
        let out = evaluate(&input);
        let _ = out.to_json();
    }
}

#[test]
fn tampered_signed_field_is_never_cleared() {
    let mut r = Rng(0xdead_beef);
    for _ in 0..2000 {
        let mut input = base();
        let field = *r.pick(&SIGNED);
        let value = weird(&mut r);
        let before = input["quote"].clone();
        set(&mut input["quote"], field, value);
        if input["quote"] == before {
            continue;
        }
        assert_ne!(evaluate(&input).verdict(), Verdict::Cleared, "changing {field} still cleared");
    }
}

//! Readback check engine.
//!
//! Reads one agent payment request (a 1Click quote, optionally with the intent the agent wants signed, or a
//! bare destination) against the owner's mandate, and returns CLEARED, HOLD or REFUSED with a status for
//! every check. Pure computation: chain lookups arrive as recorded answers in the input, so the same input
//! always gives the same verdict. See docs/SPEC.md.

pub mod address;
pub mod checks;
pub mod quote;
pub mod time;

pub use checks::{evaluate, Outcome, Status, Verdict};

/// Evaluate a JSON request and return the compact JSON verdict. Unparsable input is REFUSED.
pub fn evaluate_str(input: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(input) {
        Ok(v) => evaluate(&v).to_json().to_string(),
        Err(_) => r#"{"v":"REFUSED","c":{},"err":"bad_input"}"#.to_string(),
    }
}

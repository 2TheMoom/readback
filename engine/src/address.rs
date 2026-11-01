//! Address rules per destination chain: format and checksum, the ed25519 curve test, XRP tags.
//! Every function takes untrusted strings and must never panic.

use curve25519_dalek::edwards::CompressedEdwardsY;
use sha3::{Digest, Keccak256};

/// Chains in the 1Click token list that use 0x + 20-byte EVM addresses. One address is valid on all of
/// them, so the chain must come from the mandate, never from the address.
pub const EVM_CHAINS: [&str; 17] = ["eth", "base", "arb", "op", "pol", "bsc", "avax", "gnosis", "bera", "scroll", "monad", "xlayer", "plasma", "adi", "abs", "hood", "hypercore"];

pub fn is_evm(chain: &str) -> bool {
    EVM_CHAINS.contains(&chain)
}

/// EIP-55 mixed-case checksum form of a 0x + 40 hex address (input case is ignored).
pub fn eip55(addr: &str) -> Option<String> {
    let hex = addr.strip_prefix("0x")?;
    if hex.len() != 40 || !hex.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let lower = hex.to_ascii_lowercase();
    let hash = Keccak256::digest(lower.as_bytes());
    let mut out = String::from("0x");
    for (i, c) in lower.chars().enumerate() {
        let nibble = (hash[i / 2] >> if i % 2 == 0 { 4 } else { 0 }) & 0x0f;
        out.push(if c.is_ascii_alphabetic() && nibble >= 8 { c.to_ascii_uppercase() } else { c });
    }
    Some(out)
}

/// What the format check found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Ok,
    /// Valid, but all one case, so there is no checksum to verify (EVM only).
    OkNoChecksum,
    Bad,
}

pub fn format(chain: &str, a: &str) -> Format {
    let ok = |b: bool| if b { Format::Ok } else { Format::Bad };
    if is_evm(chain) {
        let Some(hex) = a.strip_prefix("0x") else { return Format::Bad };
        if hex.len() != 40 || !hex.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Format::Bad;
        }
        let mixed = hex != hex.to_ascii_lowercase() && hex != hex.to_ascii_uppercase();
        return if !mixed { Format::OkNoChecksum } else { ok(eip55(a).as_deref() == Some(a)) };
    }
    match chain {
        "sol" => ok(bs58::decode(a).into_vec().is_ok_and(|b| b.len() == 32)),
        "near" => ok(near_account_ok(a)),
        "tron" => ok(base58check(a, bs58::Alphabet::BITCOIN).is_some_and(|b| b.len() == 21 && b[0] == 0x41)),
        "btc" => ok(btc_ok(a)),
        "xrp" => ok(xrp_classic(a) || xrp_x_address(a)),
        _ => Format::Bad,
    }
}

/// NEAR account ids: a 64-char lowercase hex implicit account, or a named account of 2 to 64 chars made of
/// dot-separated parts of [a-z0-9] joined by single '-' or '_'.
pub fn near_account_ok(a: &str) -> bool {
    if a.len() == 64 && a.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')) {
        return true;
    }
    if !(2..=64).contains(&a.len()) {
        return false;
    }
    a.split('.').all(|part| {
        let b = part.as_bytes();
        if b.is_empty() || !b[0].is_ascii_alphanumeric() || !b[b.len() - 1].is_ascii_alphanumeric() {
            return false;
        }
        let mut prev_sep = false;
        for &c in b {
            let sep = c == b'-' || c == b'_';
            if !(sep || c.is_ascii_digit() || c.is_ascii_lowercase()) || (sep && prev_sep) {
                return false;
            }
            prev_sep = sep;
        }
        true
    })
}

/// Payload bytes (version byte included, checksum removed) if `a` is valid base58check.
fn base58check(a: &str, alphabet: &'static bs58::Alphabet) -> Option<Vec<u8>> {
    bs58::decode(a).with_alphabet(alphabet).with_check(None).into_vec().ok()
}

fn btc_ok(a: &str) -> bool {
    if let Some(b) = base58check(a, bs58::Alphabet::BITCOIN) {
        return b.len() == 21 && (b[0] == 0x00 || b[0] == 0x05);
    }
    matches!(bech32::segwit::decode(a), Ok((hrp, _, _)) if hrp.as_str() == "bc")
}

fn xrp_classic(a: &str) -> bool {
    base58check(a, bs58::Alphabet::RIPPLE).is_some_and(|b| b.len() == 21 && b[0] == 0x00)
}

/// X-addresses carry a destination tag, which 1Click cannot send.
pub fn xrp_x_address(a: &str) -> bool {
    base58check(a, bs58::Alphabet::RIPPLE).is_some_and(|b| b.len() == 31 && b[0] == 0x05 && b[1] == 0x44)
}

/// Strict ed25519 point check: canonical y (< p) and a successful decompression. An off-curve key has no
/// private key; Solana program-derived addresses are off-curve by design.
pub fn on_curve(key: &[u8]) -> bool {
    let Ok(a) = <[u8; 32]>::try_from(key) else { return false };
    let mut y = a;
    y[31] &= 0x7f;
    let mut p = [0xffu8; 32];
    p[0] = 0xed;
    p[31] = 0x7f;
    let canonical = (0..32).rev().find(|&i| y[i] != p[i]).is_some_and(|i| y[i] < p[i]);
    canonical && CompressedEdwardsY(a).decompress().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eip55_matches_known_vectors() {
        // vectors from the EIP-55 specification
        for a in ["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB", "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb"] {
            assert_eq!(eip55(&a.to_lowercase()).as_deref(), Some(a));
            assert_eq!(format("base", a), Format::Ok);
        }
        assert_eq!(format("base", "0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed"), Format::Bad);
        assert_eq!(format("base", "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"), Format::OkNoChecksum);
    }

    #[test]
    fn near_accounts() {
        for ok in ["alice.near", "acme-payments.near", "a_b.c-d.near", "readback-prework.near", &"a".repeat(64)] {
            assert!(near_account_ok(ok), "{ok}");
        }
        for bad in ["Acme.near", "a", "-a.near", "a-.near", "a--b.near", "a..near", ".near", "a.near.", "al ice.near", &"a".repeat(65)] {
            assert!(!near_account_ok(bad), "{bad}");
        }
    }

    #[test]
    fn known_public_addresses() {
        assert_eq!(format("btc", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"), Format::Ok); // genesis
        assert_eq!(format("btc", "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0"), Format::Ok); // BIP-350
        assert_eq!(format("xrp", "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"), Format::Ok); // XRP genesis
        assert_eq!(format("sol", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), Format::Ok); // USDC mint
    }

    #[test]
    fn curve() {
        let usdc_mint = bs58::decode("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").into_vec().unwrap();
        assert!(on_curve(&usdc_mint));
        let off = bs58::decode("9wQpXhE3tRk2vYfJc7ZaLbN5uD8sMq1GxTe4HnKoQ4mW").into_vec().unwrap(); // research/s6
        assert!(!on_curve(&off));
        assert!(!on_curve(&[0u8; 31]));
        let mut y_eq_p = [0xffu8; 32];
        y_eq_p[0] = 0xed;
        y_eq_p[31] = 0x7f;
        assert!(!on_curve(&y_eq_p));
    }

    #[test]
    fn hostile_strings_never_panic() {
        for s in ["", "0x", "0x😀", "😀😀😀", "\u{0}", "r", "X", "bc1", "T", "0xZZZZ", &"9".repeat(500)] {
            for chain in ["eth", "base", "sol", "near", "tron", "btc", "xrp", "unknown"] {
                let _ = format(chain, s);
            }
            let _ = xrp_x_address(s);
            let _ = eip55(s);
        }
    }
}

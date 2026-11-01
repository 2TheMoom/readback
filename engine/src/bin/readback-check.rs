//! OutLayer-style module: one JSON request on stdin, one compact JSON verdict on stdout.
//! Build for the enclave with `cargo build --release --target wasm32-wasip1`.

use std::io::{self, Read, Write};

fn main() {
    let mut input = String::new();
    let out = match io::stdin().read_to_string(&mut input) {
        Ok(_) => readback_engine::evaluate_str(&input),
        Err(_) => r#"{"v":"REFUSED","c":{},"err":"bad_input"}"#.to_string(),
    };
    let mut stdout = io::stdout();
    let _ = stdout.write_all(out.as_bytes());
    let _ = stdout.flush();
}

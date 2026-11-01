//! Acceptance tests: every vector in docs/test-vectors/vectors.json, against its hand-written expectation.

use std::{fs, path::PathBuf};

use readback_engine::{evaluate, Status};
use serde_json::{json, Value};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("docs").join("test-vectors")
}

fn load(rel: &str) -> Value {
    let p = root().join(rel);
    serde_json::from_str(&fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))).unwrap()
}

/// Apply `set` / `push` mutations. Paths start at the quote root; `msg.` paths edit the parsed intent message.
fn mutate(quote: &mut Value, intent: &mut Option<Value>, muts: &[Value]) {
    let mut msg: Option<Value> = intent.as_ref().map(|i| serde_json::from_str(i["intent"]["payload"]["message"].as_str().unwrap()).unwrap());
    for m in muts {
        let path = m["path"].as_str().unwrap();
        let (root, path) = match path.strip_prefix("msg.") {
            Some(p) => (msg.as_mut().expect("msg mutation without an intent"), p),
            None => (&mut *quote, path),
        };
        let parts: Vec<&str> = path.split('.').collect();
        let mut node = root;
        for p in &parts[..parts.len() - 1] {
            node = match p.parse::<usize>() {
                Ok(i) => &mut node[i],
                Err(_) => &mut node[*p],
            };
        }
        let last = parts[parts.len() - 1];
        match m["op"].as_str().unwrap() {
            "set" => match last.parse::<usize>() {
                Ok(i) => node[i] = m["value"].clone(),
                Err(_) => node[last] = m["value"].clone(),
            },
            "push" => node[last].as_array_mut().unwrap().push(m["value"].clone()),
            other => panic!("unknown mutation op {other}"),
        }
    }
    if let (Some(i), Some(msg)) = (intent.as_mut(), msg) {
        i["intent"]["payload"]["message"] = json!(msg.to_string());
    }
}

fn resolve_rpc(rpc: &Value, base_code: &Value) -> Value {
    let mut rpc = rpc.clone();
    if let Some(addr) = rpc.get("evm_code_ref").and_then(Value::as_str).map(str::to_ascii_lowercase) {
        rpc["evm_code"] = base_code["answers"][addr.as_str()].clone();
    }
    rpc
}

fn build_input(v: &Value, mandates: &Value, tokens: &Value, base_code: &Value) -> Value {
    let rpc = resolve_rpc(&v["rpc"], base_code);
    match v["kind"].as_str().unwrap() {
        "destination" => json!({ "kind": "destination", "chain": v["chain"], "address": v["address"], "token_contract": v["token_contract"], "rpc": rpc }),
        kind => {
            let mut quote = load(&format!("fixtures/quotes/{}.json", v["quote"].as_str().unwrap()));
            let mut intent = v["intent"].as_str().map(|i| load(&format!("fixtures/intents/{i}.json")));
            if let Some(m) = v["mutate"].as_array() {
                mutate(&mut quote, &mut intent, m);
            }
            json!({ "kind": kind, "now": v["now"], "mandate": mandates[v["mandate"].as_str().unwrap()], "quote": quote, "intent": intent, "tokens": tokens, "rpc": rpc })
        }
    }
}

fn names(out: &readback_engine::Outcome, st: Status) -> Vec<String> {
    out.checks.iter().filter(|(_, s)| **s == st).map(|(k, _)| k.to_string()).collect()
}

fn listed(expect: &Value, key: &str) -> Vec<String> {
    let mut v: Vec<String> = expect[key].as_array().map(|a| a.iter().map(|x| x.as_str().unwrap().to_string()).collect()).unwrap_or_default();
    v.sort();
    v
}

#[test]
fn every_vector_matches_its_expectation() {
    let doc = load("vectors.json");
    let (mandates, tokens, base_code) = (load("fixtures/mandates.json"), load("fixtures/tokens.json"), load("fixtures/rpc/base-eth_getCode.json"));
    let vectors = doc["vectors"].as_array().unwrap();
    let mut failures = Vec::new();
    for v in vectors {
        let out = evaluate(&build_input(v, &mandates, &tokens, &base_code));
        let e = &v["expect"];
        let want_err = e["error"].as_str();
        let got = (out.verdict().as_str().to_string(), names(&out, Status::Bad), names(&out, Status::Warn), names(&out, Status::Error), out.error.map(str::to_string));
        let want = (e["verdict"].as_str().unwrap().to_string(), listed(e, "bad"), listed(e, "warn"), if want_err.is_some() { vec![] } else { listed(e, "error") }, want_err.map(str::to_string));
        if got != want {
            failures.push(format!("{} {}\n   got  {:?}\n   want {:?}", v["id"].as_str().unwrap(), v["title"].as_str().unwrap(), got, want));
        }
    }
    assert!(failures.is_empty(), "{} of {} vectors failed:\n{}", failures.len(), vectors.len(), failures.join("\n"));
    println!("{} of {} vectors pass", vectors.len(), vectors.len());
}

/// The WASI module (what runs in OutLayer's enclave) must give byte-identical output to the native engine,
/// within OutLayer's default budget of 1e9 fuel. Runs when RB_WASM points at the built module and `wasmtime`
/// is on PATH: `RB_WASM=target/wasm32-wasip1/release/readback-check.wasm cargo test --test vectors wasm`.
#[test]
fn wasm_module_matches_native() {
    let Ok(wasm) = std::env::var("RB_WASM") else {
        eprintln!("skipped: set RB_WASM to the built readback-check.wasm");
        return;
    };
    let doc = load("vectors.json");
    let (mandates, tokens, base_code) = (load("fixtures/mandates.json"), load("fixtures/tokens.json"), load("fixtures/rpc/base-eth_getCode.json"));
    let mut checked = 0;
    for v in doc["vectors"].as_array().unwrap() {
        let input = build_input(v, &mandates, &tokens, &base_code).to_string();
        let mut child = std::process::Command::new("wasmtime")
            .args(["run", "-W", "fuel=1000000000", &wasm])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("wasmtime on PATH");
        use std::io::Write;
        child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "{} failed under wasmtime (out of fuel?)", v["id"]);
        let native = readback_engine::evaluate_str(&input);
        assert_eq!(String::from_utf8(out.stdout).unwrap(), native, "{} differs from native", v["id"]);
        checked += 1;
    }
    println!("{checked} vectors: WASI output identical to native, each within 1e9 fuel");
}

#[test]
fn output_fits_outlayer_limit() {
    let doc = load("vectors.json");
    let (mandates, tokens, base_code) = (load("fixtures/mandates.json"), load("fixtures/tokens.json"), load("fixtures/rpc/base-eth_getCode.json"));
    for v in doc["vectors"].as_array().unwrap() {
        let bytes = evaluate(&build_input(v, &mandates, &tokens, &base_code)).to_json().to_string().len();
        assert!(bytes <= 900, "{} produced {bytes} bytes", v["id"]);
    }
}

// Runs the Readback check engine: the same WASI module that runs in OutLayer's enclave
// (engine/target/wasm32-wasip1/release/readback-check.wasm). One JSON request in, one verdict out.

import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { WASI } from 'node:wasi';

const here = dirname(fileURLToPath(import.meta.url));
export const ENGINE_PATH = process.env.READBACK_ENGINE ?? join(here, '..', '..', 'engine', 'target', 'wasm32-wasip1', 'release', 'readback-check.wasm');

let cached: { module: WebAssembly.Module; sha256: string } | null = null;

function load() {
  if (!cached) {
    const bytes = readFileSync(ENGINE_PATH);
    cached = { module: new WebAssembly.Module(bytes), sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  return cached;
}

/** sha256 of the engine binary: the code hash a receipt names. */
export function engineSha256(): string {
  return load().sha256;
}

export type CheckStatus = 'ok' | 'warn' | 'error' | 'bad';
export type Verdict = 'CLEARED' | 'HOLD' | 'REFUSED';
export interface EngineOutput { v: Verdict; c: Record<string, CheckStatus>; why?: Record<string, string>; err?: string; qh?: string }

/** Run the engine on one request. Any failure to run is REFUSED: the engine never fails open. */
export function runEngine(input: unknown): EngineOutput {
  const { module } = load();
  const id = randomBytes(8).toString('hex');
  const inPath = join(tmpdir(), `readback-in-${id}.json`), outPath = join(tmpdir(), `readback-out-${id}.json`);
  writeFileSync(inPath, JSON.stringify(input));
  const inFd = openSync(inPath, 'r'), outFd = openSync(outPath, 'w');
  try {
    const wasi = new WASI({ version: 'preview1', args: [], env: {}, stdin: inFd, stdout: outFd, returnOnExit: true });
    wasi.start(new WebAssembly.Instance(module, wasi.getImportObject() as WebAssembly.Imports));
  } catch {
    return { v: 'REFUSED', c: {}, err: 'engine_failed' };
  } finally {
    closeSync(inFd); closeSync(outFd);
  }
  try {
    return JSON.parse(readFileSync(outPath, 'utf8')) as EngineOutput;
  } catch {
    return { v: 'REFUSED', c: {}, err: 'engine_failed' };
  } finally {
    unlinkSync(inPath); unlinkSync(outPath);
  }
}

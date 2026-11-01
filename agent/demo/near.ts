// What the agent's key can do, read from two NEAR RPCs that must agree. The agent refuses to start unless
// its key is a function-call key scoped to intents.near (never a full-access key) and is registered in
// intents.near for the agent's account.

type Fetch = typeof fetch;
const NEAR_RPCS = (process.env.READBACK_RPC_NEAR ?? 'https://free.rpc.fastnear.com,https://near.drpc.org').split(',').map((s) => s.trim()).filter(Boolean);
export const INTENTS = 'intents.near';

async function query(f: Fetch, url: string, params: Record<string, unknown>): Promise<any> {
  try {
    const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { finality: 'final', ...params } }), signal: AbortSignal.timeout(8000) });
    const j: any = await r.json();
    return j.error ? { unavailable: true } : j.result;
  } catch {
    return { unavailable: true };
  }
}

/** Ask every NEAR RPC; return the shared answer, or 'unavailable' if any failed or they differ. */
async function agreed<T>(f: Fetch, params: Record<string, unknown>, read: (result: any) => T): Promise<T | 'unavailable'> {
  const answers = await Promise.all(NEAR_RPCS.map((u) => query(f, u, params)));
  if (answers.some((a) => !a || a.unavailable)) return 'unavailable';
  let read_: T[];
  try { read_ = answers.map(read); } catch { return 'unavailable'; } // an answer of the wrong shape is no answer
  const first = JSON.stringify(read_[0]);
  return read_.every((x) => JSON.stringify(x) === first) ? read_[0] : 'unavailable';
}

export type Permission = 'full_access' | 'not_found' | { receiver_id: string; method_names: string[]; allowance: string | null };

export function keyPermission(f: Fetch, account: string, publicKey: string) {
  return agreed<Permission>(f, { request_type: 'view_access_key', account_id: account, public_key: publicKey }, (r) => {
    if (r.error) return 'not_found';
    if (r.permission === 'FullAccess') return 'full_access';
    const fc = r.permission?.FunctionCall;
    return { receiver_id: String(fc?.receiver_id ?? ''), method_names: (fc?.method_names ?? []).map(String), allowance: fc?.allowance ?? null };
  });
}

export function viewIntents<T>(f: Fetch, method: string, args: unknown) {
  return agreed<T | { error: string }>(f, { request_type: 'call_function', account_id: INTENTS, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') },
    (r) => (r.error ? { error: String(r.error).slice(0, 120) } : JSON.parse(Buffer.from(r.result).toString('utf8'))));
}

export interface SelfCheck { ok: boolean; problems: string[]; permission: Permission | 'unavailable'; registered: boolean | 'unavailable'; balance: string | 'unavailable' }

/** Everything the agent's key is allowed to do, and whether that is exactly what it should be. */
export async function selfCheck(f: Fetch, account: string, publicKey: string, asset: string): Promise<SelfCheck> {
  const [permission, registered, balance] = await Promise.all([
    keyPermission(f, account, publicKey),
    viewIntents<boolean>(f, 'has_public_key', { account_id: account, public_key: publicKey }),
    viewIntents<string>(f, 'mt_balance_of', { account_id: account, token_id: asset }),
  ]);
  const problems: string[] = [];
  if (permission === 'unavailable') problems.push('key_permission_unavailable');
  else if (permission === 'full_access') problems.push('agent_key_has_full_access');
  else if (permission === 'not_found') problems.push('agent_key_not_on_account');
  else if (permission.receiver_id !== INTENTS) problems.push(`agent_key_scoped_to_${permission.receiver_id || 'nothing'}`);
  if (registered !== true) problems.push(registered === 'unavailable' ? 'intents_registration_unavailable' : 'agent_key_not_registered_in_intents');
  return {
    ok: problems.length === 0, problems, permission,
    registered: registered === 'unavailable' ? 'unavailable' : registered === true,
    balance: typeof balance === 'string' ? balance : 'unavailable',
  };
}

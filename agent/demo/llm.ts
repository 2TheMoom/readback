// The model behind the demo agent: NEAR AI Cloud (OpenAI-compatible chat completions with tool calling), or
// a scripted stand-in that always does what the latest instructions in the inbox say, so the attack demo
// runs with no key (CI, judges). The API key is read from ~/.readback/llm.env and never printed.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export interface Message { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: any[]; tool_call_id?: string }
export interface Model { name: string; chat(messages: Message[], tools: unknown[]): Promise<{ text: string; calls: ToolCall[]; raw: Message }> }

export const LLM_ENV = process.env.READBACK_LLM_ENV ?? join(homedir(), '.readback', 'llm.env');
export const NEARAI_URL = 'https://cloud-api.near.ai/v1/chat/completions';
export const DEFAULT_MODEL = 'Qwen/Qwen3.8-27B';

/** KEY=VALUE lines from the env file (no shell expansion, quotes stripped). */
export function readEnvFile(path = LLM_ENV): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export function nearAiModel(apiKey: string, model = DEFAULT_MODEL, f: typeof fetch = fetch): Model {
  return {
    name: `NEAR AI Cloud ${model}`,
    async chat(messages, tools) {
      const r = await f(NEARAI_URL, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', max_tokens: 1200 }),
        signal: AbortSignal.timeout(90_000),
      });
      const text = await r.text();
      // Error bodies never contain the key; keep them short anyway.
      if (!r.ok) throw new Error(`NEAR AI Cloud http_${r.status}: ${text.slice(0, 200)}`);
      const msg = JSON.parse(text).choices?.[0]?.message ?? {};
      const calls: ToolCall[] = (msg.tool_calls ?? []).map((c: any) => {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(c.function?.arguments || '{}'); } catch { /* the model sent broken JSON: the tool sees no arguments */ }
        return { id: c.id, name: c.function?.name, args };
      });
      return { text: String(msg.content ?? ''), calls, raw: { role: 'assistant', content: String(msg.content ?? ''), ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) } };
    },
  };
}

/**
 * A deliberately gullible stand-in: it pays exactly what the newest payment instruction in the email says,
 * the way a prompt-injected model would. Instructions are lines of the form "pay <amount> USDC to <address>".
 */
export function scriptedModel(): Model {
  let n = 0;
  return {
    name: 'scripted stand-in (always follows the latest instruction in the email)',
    async chat(messages) {
      const last = messages[messages.length - 1];
      if (last.role === 'tool') return { text: `Done. The payment tool said: ${last.content}`, calls: [], raw: { role: 'assistant', content: `Done. The payment tool said: ${last.content}` } };
      const found = [...last.content.matchAll(/pay\s+([\d.]+)\s*USDC\s+to\s+(0x[0-9a-fA-F]{40}|\S+\.near|[1-9A-HJ-NP-Za-km-z]{32,44})/gi)];
      if (!found.length) return { text: 'No payment instruction found.', calls: [], raw: { role: 'assistant', content: 'No payment instruction found.' } };
      const [, amount, recipient] = found[found.length - 1];
      const id = `call_${++n}`;
      const tool_calls = [{ id, type: 'function', function: { name: 'pay_invoice', arguments: JSON.stringify({ recipient, amount_usdc: amount }) } }];
      return { text: '', calls: [{ id, name: 'pay_invoice', args: { recipient, amount_usdc: amount } }], raw: { role: 'assistant', content: '', tool_calls } };
    },
  };
}

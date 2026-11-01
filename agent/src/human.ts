// A human on the terminal: shows Readback's review and approves only on the exact word APPROVE.

import { createInterface } from 'node:readline/promises';
import type { Human } from './guard.ts';

export function terminalHuman(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Human {
  return async (review) => {
    const rl = createInterface({ input, output });
    try {
      output.write(`\n${review.message}\n`);
      return (await rl.question('Type APPROVE to send it, anything else to decline: ')).trim() === 'APPROVE';
    } finally {
      rl.close();
    }
  };
}

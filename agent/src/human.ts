// A human on the terminal: shows Readback's review and approves only on the exact word APPROVE. If there is
// no one to answer (input closed, as when the agent runs unattended), that is a no, at once.

import { createInterface } from 'node:readline';
import type { Human } from './guard.ts';

export function terminalHuman(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Human {
  return (review) => new Promise<boolean>((resolve) => {
    const rl = createInterface({ input, output });
    let answered = false;
    rl.on('close', () => { if (!answered) { output.write('\n(no answer: declined)\n'); resolve(false); } });
    output.write(`\n${review.message}\n`);
    rl.question('Type APPROVE to send it, anything else to decline: ', (a) => { answered = true; rl.close(); resolve(a.trim() === 'APPROVE'); });
  });
}

// SPIKE 1 (throwaway, pre-hackathon research). Not product code.
// Question: what intent types can a 1Click / Verifier payload carry, and which fields does each have?
const fs = require('fs');
const yaml = require('js-yaml');
const spec = yaml.load(fs.readFileSync(__dirname + '/oneclick-openapi.yaml', 'utf8'));
const S = spec.components.schemas;

const rows = [];
for (const variant of S.Intent.oneOf) {
  const name = variant.properties.intent.enum[0];
  const req = (variant.required || []).filter(f => f !== 'intent');
  const opt = Object.keys(variant.properties).filter(f => f !== 'intent' && !req.includes(f));
  rows.push({ name, req, opt });
}
console.log(`${rows.length} intent types`);
for (const r of rows) console.log(`${r.name.padEnd(28)} required: ${r.req.join(', ') || '-'}   optional: ${r.opt.join(', ') || '-'}`);

// Quote request / response field inventory
const qr = S.QuoteRequest; const q = S.Quote;
console.log('\nQuoteRequest required:', (qr.required || []).join(', '));
console.log('Quote fields:', Object.keys(q.properties).join(', '));
console.log('Quote required:', (q.required || []).join(', '));
fs.writeFileSync(__dirname + '/out-intent-types.json', JSON.stringify({ intents: rows, quoteRequestRequired: qr.required, quoteFields: Object.keys(q.properties) }, null, 1));

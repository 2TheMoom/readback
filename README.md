# Readback

Readback reads every agent payment back to its owner as one plain sentence, marks anything that does not match what the owner allowed, and returns a verdict: CLEARED, HOLD or REFUSED.

Status: in development for NEAR HACKATHON (1 to 14 November 2026). Tracks: security, agents.

## What exists today

- `docs/SPEC.md`: the 16 checks, the verdict rules and how each input is decoded.
- `docs/test-vectors/`: 51 acceptance tests built on real, signed 1Click quotes and a real generated intent.
- `docs/THREAT-MODEL.md`: what can go wrong with Readback itself, and how it is handled.
- `research/`: the experiments behind the spec, with reproducible scripts.

The engine, service and app are being built in this repository during the hackathon.

## Work before 1 November

Research, the spec, the test vectors, the experiments in `research/` and a clickable design mock were made between 23 and 31 October 2026, which is inside the hackathon window under rule Q-001 (work from the 19 October announcement counts). `docs/WORKLOG.md` lists that work by date. No code from earlier projects is used.

## License

MIT. See `LICENSE`.

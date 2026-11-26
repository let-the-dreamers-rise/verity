# Verity

**The host that bills you also reads the meter.** Verity is an independent audit of open-model inference hosts. It sends the same unannounced requests to every host of the same model, compares what came back and what was billed, and publishes the result with raw evidence.

Status: early. The engine and board work. No audit has been published yet, and this repository will say so plainly if the first audits find nothing worth reporting.

## What it measures

| Check | How | Flagged when |
| --- | --- | --- |
| Token ratio | Hosts repeat a fixed text. Identical output must cost the same tokens, so each host's billed completion tokens are divided by the median across hosts of that model. Needs 3 or more hosts with byte-identical output. | above 1.15 |
| Tool calls | Function-calling requests must return the right tool with arguments that pass the JSON schema. | accuracy below 90% |
| Cut-offs | Long answers must reach a requested end marker and not come back empty. | above 5% |
| Agreement | At temperature 0, a host's answers are compared with the closest half of its peers (or with a reference endpoint if one is marked). Low agreement can mean a different, quantized or misconfigured model. | below 0.60 |
| Availability | Share of probes that got a usable answer. | below 95% |

Thresholds are provisional and live in `src/scorers.ts`.

## Limits, stated up front

- A flag is a measurement that crossed a threshold. It is not proof of intent, and it is not an accusation.
- The default probe set is small (36 probes) and public, so a host could special-case it. Serious runs add a private probe set through `VERITY_PROBES_FILE`.
- Free tiers are rate limited. Calls answered with HTTP 429 are left out of every score, and the report says how many there were, so a thin run is visible as thin.
- Honest hosts can differ at temperature 0 because of hardware, quantization or sampling defaults. Agreement is a signal to investigate, not a verdict.
- Hosts reached through a router (OpenRouter, the Hugging Face router) are measured as that router bills and returns them.

## Data-handling audits (in progress)

Quality checks tell you whether a host serves the model it claims. They do not tell you what happens to your prompts afterwards. In November 2026 a canary study found several inference providers whose baited prompts, including zero-data-retention traffic, were later used by someone else, and OpenRouter pulled 125 endpoints from its zero-data-retention pool. Verity's main line of work is now measuring that, continuously and per host.

How it works:

1. Each run makes fresh, unique bait for every host: a document link and a fake API key that point at the Verity listener. The bait sits inside an ordinary-looking prompt.
2. Only SHA-256 hashes of the bait are published (`results/canary/seeds/`). Their Merkle root is written to Solana before a single prompt is sent, so nobody, including Verity, can later claim a hit came from a host that was never sent that bait.
3. The listener (`listener/`) records any request that carries a bait token: which token, which route (link or key), when, and from where. A hit means the prompt left the host's serving path and was read or used by something.
4. A host with a hit is told privately first, with the evidence, and the result is published after a notice period.

What a hit does and does not prove: it proves the exact text sent only to that host was later acted on. It does not by itself say who acted on it or why (a logging vendor, a crawler that follows links in logs, a trained model, a breach). A run with no hits is weak evidence of good handling, not proof of it.

Run it: `node src/seed.ts --selftest --per-endpoint 3` (or the Canary workflow). The `--selftest` seed is fetched by Verity itself, so the board can show the listener is working.

## Run it

Needs Node 22.18 or newer. There are no dependencies to install.

```sh
npm test            # unit tests, no network
npm run audit:dry   # shows which endpoints have a key, sends nothing
npm run audit       # runs every endpoint whose key is in the environment
```

Endpoints are listed in `endpoints.json`. Each one names the environment variable that holds its key (today `HF_TOKEN` and `OPENROUTER_API_KEY`). `npm run discover` lists which hosts serve which models right now. Keys are read from the environment only and are never written to results.

Each run writes:

- `results/DATE.json` and `results/latest.json`: the scored report
- `results/raw/DATE.json`: every request outcome, so anyone can recompute the scores
- the SHA-256 of the raw file inside the report

## Daily audit and public board

`.github/workflows/audit.yml` runs once a day (and on demand from the Actions tab), commits the results, and publishes `site/` to GitHub Pages. To turn it on:

1. Add host keys under Settings, Secrets and variables, Actions. Any subset works; endpoints without a key are skipped.
2. Under Settings, Pages, set the source to "GitHub Actions".

## Roadmap

- Wider coverage: more models, more hosts, paid tiers, a private rotating probe set.
- Anchor each day's evidence hash on Solana (built; needs a funded signing key in the listener).
- Pay for probes anonymously over x402 so hosts cannot recognise the auditor.
- Later: hosts post a USDC bond against their published numbers, with refunds to buyers when an audit shows a miss.

## Disputes

If you run a host listed here and think a result is wrong, open an issue. The raw evidence for every run is in `results/raw/`, and corrections are published in the open.

MIT licensed.

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
- The default probe set is small (24 probes) and public, so a host could special-case it. Serious runs add a private probe set through `VERITY_PROBES_FILE`.
- Free tiers are rate limited. Calls answered with HTTP 429 are left out of every score, and the report says how many there were, so a thin run is visible as thin.
- Honest hosts can differ at temperature 0 because of hardware, quantization or sampling defaults. Agreement is a signal to investigate, not a verdict.
- Hosts reached through a router (OpenRouter, the Hugging Face router) are measured as that router bills and returns them.

## Run it

Needs Node 22.18 or newer. There are no dependencies to install.

```sh
npm test            # unit tests, no network
npm run audit:dry   # shows which endpoints have a key, sends nothing
npm run audit       # runs every endpoint whose key is in the environment
```

Endpoints are listed in `endpoints.json`. Each one names the environment variable that holds its key: `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN`. Keys are read from the environment only and are never written to results.

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
- Anchor each day's evidence hash on Solana so results cannot be quietly rewritten.
- Pay for probes anonymously over x402 so hosts cannot recognise the auditor.
- Later: hosts post a USDC bond against their published numbers, with refunds to buyers when an audit shows a miss.

## Disputes

If you run a host listed here and think a result is wrong, open an issue. The raw evidence for every run is in `results/raw/`, and corrections are published in the open.

MIT licensed.

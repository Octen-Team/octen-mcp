# Eval suite

Behavioural tests for the plugin's two skills. `claude plugin validate` checks
that the manifests parse; these check that the skills actually change what
Claude does.

## Run

```bash
claude plugin eval .            # from the repo root
claude plugin eval . --case single-fact-lookup
claude plugin eval . --ablation none      # skip the no-plugin arm while iterating
```

Each case sets `runs: 2` and the default ablation runs both arms, so a case is
four agent runs and the six-case suite is twenty-four. The reported `Δ` is the
with-arm score minus the without-arm score, which is the number that says
whether the plugin earned its context cost. Budget accordingly — the suite has
cost $4-5 per full run.

## What each case pins down

| Case | The decision under test |
|--|--|
| `single-fact-lookup` | A one-fact question goes to `search`, not `broad_search` |
| `two-way-comparison` | A vs B is two `search` calls, not one fan-out — `searched-each-side` counts them |
| `landscape-survey` | An open-ended "what are the options" does fan out |
| `read-a-url` | A URL already in hand goes straight to `extract`, with no search first |
| `research-pipeline` | Deep research fans out **and** grounds the answer in extracted pages |
| `beta-tool-denied` | An invite-only Beta tool returning 403 is surfaced as needing access, not as an empty result |

## Mocks

`mocks/octen/` stands in for the hosted MCP server, so a run needs no network,
no credential, and returns the same thing every time. A tool with no mock file
is not offered to Claude at all, so every tool in the roster has one. The
`image_search` and `video_search` mocks return the 403 an account without Beta
access gets, which is what most accounts see.

`mocks/octen/_tools.json` is the roster the mocked tools are served with;
without it they arrive with no description and the model never calls them. It
is generated from this repo's own build, not from the hosted deployment, so the
suite grades routing against what this repo ships:

```bash
npm run build && node scripts/refresh-eval-tools.mjs
```

CI runs the same script with `--check` and fails if the checked-in copy has gone
stale, which is what catches a tool-description rewrite that the suite would
otherwise keep grading against the old roster.

Each mock opens its body with a marker — `[MOCK:search]`, `[MOCK:broad_search]`,
`[MOCK:extract]`. The routing graders match those markers in `mock_calls`
rather than tool names, so they keep working regardless of how the runtime
namespaces a plugin's MCP tools.

To run against the real server instead, pass `--mocks off --allow-tools 'mcp__*'`.
`--allow-real-servers` will not do it: that flag only starts real servers for
servers with *no* mock, and every tool here has one, so the run silently keeps
using the fixtures. A real run needs a working Octen sign-in and is
non-deterministic.

CI does not run the suite — each case spends real model tokens. What CI does run
is `scripts/check-plugin-manifests.mjs` and the `--check` above, so a manifest
that drifts from `package.json` and a stale tool roster both fail the build.

## Anchor the graders on facts the model cannot already know

A grader that checks for a real-world fact measures the model's memory, not the
plugin. Two rounds of this suite scored `Δ 0.00` across the board because the
no-plugin arm answered correctly from training data: Lambda Labs' published
H100 rate and the names of the well-known gateways are both things the model
recalls without retrieving anything.

Every scored grader now matches something that exists only in the fixtures:
a price that deliberately differs from the published one, an invented release
number, a gateway (`Relaypoint`) that does not exist. The no-plugin arm cannot
produce any of them, so the delta measures retrieval rather than recall.

The inverse trap is just as easy to fall into. An invented entity named in the
*prompt* makes the model stop and ask who that is instead of searching, which
is the correct behaviour and scores zero. Keep the prompt in real-world terms
and put the invented material in what the mocks return.

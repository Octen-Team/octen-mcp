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

Each case runs twice by default: once with the plugin loaded and once without.
The reported `Δ` is the difference, which is the number that says whether the
plugin earned its context cost.

## What each case pins down

| Case | The decision under test |
|--|--|
| `single-fact-lookup` | A one-fact question goes to `search`, not `broad_search` |
| `two-way-comparison` | A vs B is two `search` calls, not one fan-out |
| `landscape-survey` | An open-ended "what are the options" does fan out |
| `read-a-url` | A URL already in hand goes straight to `extract`, with no search first |
| `research-pipeline` | Deep research fans out **and** grounds the answer in extracted pages |

## Mocks

`mocks/octen/` stands in for the hosted MCP server, so a run needs no network,
no credential, and returns the same thing every time. A tool with no mock file
is not offered to Claude at all, so adding a case that exercises
`news_search`, `image_search`, or `video_search` means adding its mock first.

Each mock opens its body with a marker — `[MOCK:search]`, `[MOCK:broad_search]`,
`[MOCK:extract]`. The routing graders match those markers in `mock_calls`
rather than tool names, so they keep working regardless of how the runtime
namespaces a plugin's MCP tools.

To run against the real server instead, pass `--allow-real-servers`. That needs
a working Octen sign-in and makes the results non-deterministic; the mocked run
is the one to gate CI on.

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

You are judging agreement between {{PANEL_SIZE}} independent reviews of the open decisions on issue
**#{{ISSUE}}** of the {{PROJECT}} repository: "{{TITLE}}".

Each reviewer answered the same decisions without seeing the others. Below, for each decision, are
their answers. Your job is to say, decision by decision, whether they **agree in substance**: whether
acting on any one of the answers would produce the same change. Different words for the same thing
agree. Answers that would lead to different code, different behavior, or different text a user reads
in substance do not agree, however close they sound.

Be strict. A decision you call agreed goes ahead with no person reading it first; a decision you call
split costs a person one reply. When in doubt, it is split.

You are running headless. This is a read-only job in an empty scratch directory. You may read the
issue with `gh -R {{REPO}} issue view {{ISSUE}} --comments` and code from `{{MAIN_CHECKOUT}}`, but edit
nothing anywhere.

## The answers

{{ANSWERS}}

## What you do

For each of {{QUESTION_IDS}}:

- **Agreed:** write the one answer that goes ahead, in `decision`, and one line of reasoning. For
  copy, the substance must match; pick the wording by a stated rule (reuse the product's existing
  strings and templates first, then the written conventions, then the plainest wording) and name the
  rule in `wordingRule`.
- **Split:** list each distinct position once in `positions`, with the reviewer numbers that took it.

## Write the answer

Write `loop-panel-judgment.json` in the directory you were started in. It is the only thing read.

```json
{
  "issue": {{ISSUE}},
  "questions": [
    { "id": "Q1", "agreed": true, "decision": "the answer that goes ahead", "reasoning": "one line", "wordingRule": "for copy only" },
    { "id": "Q2", "agreed": false, "positions": [{ "text": "one position", "reviewers": [1, 3] }, { "text": "the other", "reviewers": [2] }] }
  ]
}
```

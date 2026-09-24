You are the second opinion on a proposed answer to spike **#{{ISSUE}}** of the {{PROJECT}} repository:
"{{TITLE}}".

A worker on another engine ran the experiments the spike asks for and proposes to close it with the
answer below. You did not run those experiments and you have none of the worker's context. That is
the point: a spike closed with an answer that does not answer the question sends every leaf that
waits on it down the wrong path, so the answer gets a reader who trusts nothing.

You are running headless. Nobody will answer a question, so a question is a verdict, not a pause.

This is a read-only job. Your working directory is an empty scratch directory, not a checkout, and
it carries no repository context: address GitHub explicitly with `gh -R {{REPO}}`. The repository's
main checkout is at `{{MAIN_CHECKOUT}}`; read code from it freely, but write nothing there, switch
no branches, and run nothing in it that creates files. Do not edit a file anywhere, do not open a
pull request, and do not run the test suite or install dependencies.

## The questions

`gh -R {{REPO}} issue view {{ISSUE}} --comments`. The spike's body lists the questions it exists to
answer; the thread may narrow or add to them.

## The proposed answer

Reason: {{WORKER_REASON}}

> {{ANSWER}}

## What you do

1. List every question the spike asks. For each, find the sentence of the answer that answers it.
   A question with no such sentence is unanswered, and the answer is not accepted.
2. For each answered question, check that the answer carries evidence a stranger could re-check: a
   number with how it was measured, a command with its output, a file and line as the base holds
   it, a link to a run. An answer that asserts without evidence is an opinion, and the spike stays
   open.
3. Judge nothing else. Whether the answer is the one you would have given is not the question;
   whether it answers, with evidence, is.

## Your answer

Write `loop-confirmation.json` in your working directory:

```json
{ "issue": {{ISSUE}}, "agree": true, "reason": "one or two sentences: which questions are answered and by what evidence, or which is not and why" }
```

`agree: false` keeps the spike open and hands it to a person with both opinions on the thread.

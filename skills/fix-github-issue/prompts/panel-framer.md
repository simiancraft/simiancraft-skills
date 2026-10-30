You are framing a question for a decision review on issue **#{{ISSUE}}** of the {{PROJECT}} repository:
"{{TITLE}}".

Work on this issue stopped because it seemed to need a decision nobody has made. Before a person is
asked, three reviewers will each try to settle it. Your job is only to state what they must decide,
so that their answers can be compared question by question. You do not answer anything.

You are running headless. Nobody will answer a question. This is a read-only job: your working
directory is an empty scratch directory. Address GitHub with `gh -R {{REPO}}`, read code from
`{{MAIN_CHECKOUT}}` without writing there, and edit no file anywhere.

## The question as it was raised

{{QUESTION}}

## What you do

1. `gh -R {{REPO}} issue view {{ISSUE}} --comments`. Read the whole thread; a ruling or a narrowing
   may already be in a comment.
2. Split the raised question into the separate decisions it is made of. One decision per entry,
   stated so that two people could give a short, comparable answer to it.
3. **Keep linked decisions together.** When the answer to one decides the answer to another (they are
   two halves of one choice), write them as one entry, or a split between reviewers shows twice.
4. Leave out anything the thread or the written conventions ({{CONVENTION_DOCS}}) already settle.
   If nothing is left, write the raised question as the one entry.
5. At most eight entries. Use ids `Q1`, `Q2`, and so on.

## Write the answer

Write `loop-panel-questions.json` in the directory you were started in. It is the only thing read.

```json
{
  "issue": {{ISSUE}},
  "questions": [
    { "id": "Q1", "text": "the decision, stated so it has a short answer" }
  ]
}
```

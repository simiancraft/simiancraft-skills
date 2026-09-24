# Size callbacks the loop ships

`on-size-over-ceiling` is a template. On every start the loop renders it into the adopting
repository's callbacks directory (`callbacksDir`, by default `<worktreeRoot>/appraisal-callbacks`)
as `on-size-over-<maxPoints>`, substituting the repository root, the knife's directory, and the
ceiling, so the appraiser hands every issue it sizes over the ceiling to `carve-github-issue`
without knowing the knife exists. The ladder and both callback forms are documented in
`../../appraise-github-issues/references/callbacks.md`.

The rendered file's second line is an ownership marker (`# rendered by burn-down-github-issues;
edits are overwritten`). Only files carrying it are ever removed (a rendering for an earlier
ceiling) or overwritten; a file at the rendered name without the marker is the adopter's, is
refused with a log line, and is left alone. The rendering happens in `lib/place-callbacks.ts`,
which is tested against a temporary directory.

The knife runs with the seats the loop chose (`--carver`, `--carve-confirmer`, or the config's),
passed through the environment as `LOOP_CARVER` and `LOOP_CARVE_CONFIRMER`.

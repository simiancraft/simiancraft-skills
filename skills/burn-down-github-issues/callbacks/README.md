# Size callbacks the loop ships

Files here named `on-size-<N>`, `on-size-over-<M>`, or `on-size` (with or without `.md`) are copied
into the adopting repository's callbacks directory on every start, and the appraiser looks one up
for each issue it sizes. The ladder and both forms are documented in
`../../appraise-github-issues/references/callbacks.md`. This directory holds nothing yet; a
producer that wants something to happen for a size adds the file here (shipped with the loop) or
in the adopter's directory (local to one repository).

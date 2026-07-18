# Learning proof: multiple output types

The **DAILY_EXECUTION** API accepts `proof.proofTypes` (array of codes) on `POST .../learning-proof`.

- The controller sends the **first** code to `USP_SUBMIT_LEARNING_PROOF` as `@PROOFTYPECODE` (same as before, for stored-proc compatibility).
- If the user selects more than one output, the full list is appended to `descriptionText` as a final line: `[Outputs: CODE1, CODE2, ...]`.

To persist all codes in `LEARNINGPROOF.PROOFTYPES` without touching the description, update `USP_SUBMIT_LEARNING_PROOF` to:

1. Accept a comma-separated list in `@PROOFTYPECODE` (or add `@PROOFTYPESCODES`).
2. Validate each token against the rule’s allowed proof types.
3. Store the joined string in the proof row.

Until then, the behavior above keeps the UI and audit trail consistent.

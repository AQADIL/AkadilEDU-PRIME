# AkadilEDU Question Studio

A local browser workspace for generating and reviewing original UNT mathematics practice questions through the OpenAI API. It uses the project's existing Firebase Realtime Database and Cloud Storage.

## Run

Install dependencies with `npm ci` inside `question-studio`. Copy `.env.example` to `.env` and supply all required values. `STUDIO_ENV_FILE` can reference the existing project's environment file for Firebase credentials and the API key. Studio settings take precedence over that file.

Run `npm run check`, then `npm start`. Open the exact `STUDIO_PUBLIC_ORIGIN` configured in `.env`. The host must be a loopback address and the origin must match the configured host and port. Keep the process and computer running while generation is active.

`OPENAI_MODEL`, API endpoint, token prices, reasoning effort and maximum output tokens are explicit settings. Verify model access and current prices before starting. `STUDIO_BUDGET_USD` cannot exceed the authorized $50. This is the studio run's API budget, not an account-wide spending limit and not a Firebase billing limit.

## Workflow

The topic list comes from live `/topics`. Only exact boolean `isLast === true` nodes are eligible; the service node `RANDOM` is excluded. Geometry and mathematical literacy are included. Cycles and missing parents stop loading instead of creating a misleading topic path.

The initial per-topic quantity is an estimate. The authoring model recommends a distinct target and coverage goals for each topic after its first batch. Global difficulty selection aims approximately at 25% easy, 45% medium and 30% hard. The worker first requests one question for each untouched topic, then uses the configured batch size and prioritizes topics with fewer accepted questions. After three entirely rejected batches a topic is deferred for investigation rather than consuming the remaining budget indefinitely.

Each question has equivalent Kazakh, Russian and English statements, choices, explanations and hints, a shared zero-based correct answer, and provenance. A separate API request solves and reviews the generated batch. Failed mathematical, translation, topic, difficulty, diagram or format checks reject the question. AI review reduces errors but does not certify correctness; the panel shows both accepted content and rejection reasons.

Question statements use ordinary Unicode math when practical. Necessary LaTeX is limited to the statement and rendered locally. Options, explanations, hints and labels must be plain Unicode. Visual questions include structured diagram geometry. The renderer creates a labelled PNG with the statement for each language, compresses it and uploads it to Cloud Storage. It does not execute model-supplied SVG or HTML.

Validated questions are stored under `/questions`, with `/questionsByTopic` membership. `STUDIO_AUTO_PUBLISH=true` publishes accepted questions; `false` saves drafts for manual publication in the studio. Manual publication requires validated questions and a stopped worker. Bot practice, channel campaigns, review and the admin editor understand the same translations.

## Source parsing

Choose source parsing and paste text that you are entitled to process. The model extracts complete questions, independently solves them and classifies them into eligible leaf topics. Every processed source prefix must match the original exactly. Incomplete or ambiguous material stops with a visible error and retained input; it is not silently discarded or invented.

## Costs and recovery

Before each paid request the studio persists a conservative reservation for input and maximum output tokens. Output accounting includes reasoning tokens. A request cannot start if it could exceed the remaining budget. Completed requests use the API's reported token usage and configured prices; uncertain requests retain their reservation.

The price forecast is measured from accepted results, includes rejected work and changes as more tasks are processed. It is an estimate, not a promise of quantity. A quality-first model may exhaust $50 before reaching every topic's desired coverage.

State, API response IDs, review results and local images are kept in `STUDIO_DATA_DIR`. Pausing finishes the current API request and preserves its result. Resuming retrieves the same background response rather than repeating the paid request. If the network fails before a response ID is received, the studio stops and keeps the reserve. Reconcile such a request against provider usage before changing its persisted state.

Use one studio process per data directory. A process lock prevents concurrent writers. Do not delete the data directory to reset the displayed spend: that would discard the run's accounting. Credentials, local configuration and the default `.data` directory are excluded from Git.

Firebase billing is separate. Text is stored in Realtime Database; only needed images are stored in Cloud Storage. Download volume and other existing project services also affect charges. A Google Cloud budget alert alone does not impose a spending cap.

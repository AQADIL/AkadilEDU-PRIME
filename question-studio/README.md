# AkadilEDU Question Studio

A local browser workspace for generating and reviewing original UNT mathematics practice questions through the OpenAI API. It uses the project's existing Firebase Realtime Database and Cloud Storage.

## Run

Install dependencies with `npm ci` inside `question-studio`. Copy `.env.example` to `.env` and supply all required values. `STUDIO_ENV_FILE` can reference the existing project's environment file for Firebase credentials and the API key. Studio settings take precedence over that file.

Run `npm run check`, then `npm start`. Open the exact `STUDIO_PUBLIC_ORIGIN` configured in `.env`. The host must be a loopback address and the origin must match the configured host and port. Keep the process and computer running while generation is active.

`OPENAI_MODEL`, API endpoint, token prices, reasoning effort and maximum output tokens are explicit settings. Verify model access and current prices before starting. `STUDIO_BUDGET_USD` cannot exceed the authorized $50. This is the studio run's API budget, not an account-wide spending limit and not a Firebase billing limit.

`OPENAI_MODEL` handles question creation, translations and geometry research. `OPENAI_REVIEW_MODEL` handles the separate solution and quality review, with its own four `OPENAI_REVIEW_*_PRICE_PER_MILLION` settings. Reservations and actual charges use the selected role's prices. Both roles share the same total budget. Previously completed requests retain their original models, prices and results when either role changes.

Requests use the standard service tier. Each request records its model and prices, so switching models preserves historical costs. Switch only after outstanding calls have settled. For runs created before price snapshots existed, supply `OPENAI_LEGACY_MODEL` and the four `OPENAI_LEGACY_*_PRICE_PER_MILLION` values matching the original run. Existing completed questions keep their actual authoring model; reviewer identity is recorded separately.

## Workflow

The topic list comes from live `/topics`. Only exact boolean `isLast === true` nodes are eligible; the service node `RANDOM` is excluded. Geometry and mathematical literacy are included. Cycles and missing parents stop loading instead of creating a misleading topic path.

The initial per-topic quantity is an estimate. The authoring model recommends a distinct target and coverage goals for each topic after its first batch. Global difficulty selection aims approximately at 25% easy, 45% medium and 30% hard. The worker first requests one question for each untouched topic, then uses the configured batch size and prioritizes topics with fewer accepted questions. After three entirely rejected batches a topic is deferred for investigation rather than consuming the remaining budget indefinitely.

Each question has equivalent Kazakh, Russian and English statements, choices, explanations and hints, a shared zero-based correct answer, and provenance. A separate API request solves and reviews the generated batch. Failed mathematical, translation, topic, difficulty, diagram or format checks keep a question unpublished. Rejected questions enter an automatic repair queue: the authoring model receives the reviewer’s concrete findings, proposes a complete correction, and the separate review model checks the revised question again. Accepted corrections replace the rejected version under the same question ID. The original and subsequent findings, response IDs and repair attempt count remain in the audit history. The panel shows queued, running, completed and exhausted repairs; exhaustion leaves a question unpublished and does not prevent other questions from being processed. AI review reduces errors but does not certify correctness.

Question statements use ordinary Unicode math when practical. Necessary LaTeX is limited to the statement and rendered locally. Options, explanations, hints and labels must be plain Unicode. Visual questions include structured diagram geometry. Diagram PNGs omit the statement; identical drawings share one uploaded image across languages. Translated labels produce separate images only when their visible content differs. A localized prose prefix followed by standalone LaTeX blocks is split into text and a formula image. Identical formula/drawing content reuses one PNG and one Storage object across languages. The original statement stays in local state for review and re-rendering; Firebase receives the separate display text with `imageContainsStatement=false`. Interleaved prose and formulas retain their original order in a full statement image with `imageContainsStatement=true`. Diagram-only images also carry `false` so the bot displays the localized statement. Missing flags retain legacy behavior. Captions are accessibility metadata, while essential information belongs in the statement or visible labels. Exported PNGs are cropped to the visible ink, preserving thin formula and diagram strokes, then receive a 24-pixel white border on every side. Short formulas no longer inherit the full browser canvas width. The renderer does not execute model-supplied SVG or HTML.

The diagram conventions were checked against the NTC's [Russian sample, page 3](https://testcenter.kz/wp-content/uploads/2024/12/obr_var_test_16.pdf) and [English sample, pages 2 and 4](https://testcenter.kz/wp-content/uploads/2025/06/MATHEMATICS.pdf): readable vertex labels, angle arcs, right-angle marks, dashed hidden edges and selective region shading. Ellipse arcs support projected circular rims. Measured label placement avoids overlaps and clipping; diagrams that cannot be arranged legibly are rejected. These original practice questions are not official NTC exam items.

## Geometry references

With `STUDIO_WEB_SEARCH_ENABLED=true`, the worker researches each geometry leaf topic once through the API's real web search tool and caches the result. `STUDIO_WEB_SEARCH_MAX_CALLS` limits built-in calls per research response. Research reserves `STUDIO_WEB_SEARCH_INPUT_TOKEN_RESERVE` input tokens plus maximum output and tool fees before dispatch, within the same total budget. Search fees use `OPENAI_WEB_SEARCH_PRICE_PER_CALL`.

Only source URLs returned by the search tool are retained. The question preview links to reference sources, and Firebase provenance records the research response. Sources inform methods, coverage and diagram conventions for original questions; the pipeline does not bulk-copy collections. No-search or empty results are reported honestly and cached. Research failures retain their call ID for recovery instead of issuing an automatic paid replacement.

Validated questions are stored under `/questions`, with `/questionsByTopic` membership. `STUDIO_AUTO_PUBLISH=true` publishes accepted questions; `false` saves drafts for manual publication in the studio. Manual publication requires validated questions and a stopped worker. Bot practice, channel campaigns, review and the admin editor understand the same translations.

## Source parsing

Choose source parsing and paste text that you are entitled to process. The model extracts complete questions, independently solves them and classifies them into eligible leaf topics. Every processed source prefix must match the original exactly. Incomplete or ambiguous material stops with a visible error and retained input; it is not silently discarded or invented.

## Costs and recovery

`STUDIO_STATE_WRITE_TIMEOUT_MS` bounds retries when another process temporarily locks the state file. Each retry preserves atomic replacement; a persistent storage failure stops the worker before it can dispatch an unrecorded paid request.

`STUDIO_RECOVERY_BACKOFF_MS` controls the recovery delay after prolonged temporary response-retrieval failures. The worker honors a longer provider `Retry-After`, preserves the existing response ID and reservation, and resumes retrieving the same request when connectivity returns. Pausing interrupts this recovery wait. Authentication failures and inconsistent accounting remain explicit stops.

`STUDIO_API_MAX_ATTEMPTS` bounds automatic replacement requests after known recoverable API failures. A response that ends at `max_output_tokens` may be retried with a larger output allowance, capped by `STUDIO_RETRY_MAX_OUTPUT_TOKENS`. Each attempt retains its own response ID, usage, price snapshot and retry links. Both the failed attempt and its replacement count toward the same budget. Unknown request outcomes and unreconciled usage still stop processing to avoid duplicate charges.

`STUDIO_REPAIR_MAX_ATTEMPTS` bounds correction rounds for each rejected question. `STUDIO_MAX_TOPIC_FAILURES` bounds consecutive request failures for a topic in generation mode; exhausted topics are deferred while other eligible topics continue. Pausing preserves the current attempt, and resuming continues from saved request IDs. Reaching the total budget prevents further paid calls, including retries and corrections.

Before each paid request the studio persists a conservative reservation for input and maximum output tokens. Output accounting includes reasoning tokens. A request cannot start if it could exceed the remaining budget. Completed requests use the API's reported token usage and configured prices; uncertain requests retain their reservation.

Ordinary input, cache reads and cache writes are charged separately. `OPENAI_CACHE_WRITE_PRICE_PER_MILLION` is the full write price for the model's default cache duration. The studio does not request extended cache retention; unexpected 12-hour writes or inconsistent usage stop processing with the reservation retained. Historical corrections require retrieving actual response usage and using the original request's price snapshot.

The price forecast uses completed batches produced by the current model pair, including their rejected work, repair rounds, research, independent reviews and linked API retries. Each related call is charged once in the sample. Batches still being repaired are excluded until their outcome is known. Missing accounting links hide the forecast instead of presenting an underestimated price; actual recorded spend and reserves remain visible. The forecast changes as more tasks are processed. It is an estimate, not a promise of quantity. A quality-first model may exhaust $50 before reaching every topic's desired coverage.

State, API response IDs, review results and local images are kept in `STUDIO_DATA_DIR`. Pausing finishes the current API request and preserves its result. Resuming retrieves the same background response rather than repeating the paid request. If the network fails before a response ID is received, the studio stops and keeps the reserve. Reconcile such a request against provider usage before changing its persisted state.

Use one studio process per data directory. A process lock prevents concurrent writers. Do not delete the data directory to reset the displayed spend: that would discard the run's accounting. Credentials, local configuration and the default `.data` directory are excluded from Git.

Firebase billing is separate. Text is stored in Realtime Database; only needed images are stored in Cloud Storage. Download volume and other existing project services also affect charges. A Google Cloud budget alert alone does not impose a spending cap.

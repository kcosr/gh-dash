# Browser regression tests

Run `npm ci`, install Chromium with `npx playwright install chromium`, then run
`npm run test:browser`. The command verifies the vendored Workbench snapshot,
builds the application, and serves that build on localhost port 4187 for Playwright.
The port must be free. `npm run typecheck:browser` checks this harness separately.

These tests exercise real Chromium against deterministic, synthetic API responses.
They do not start the backend, contact GitHub or GitLab, use credentials, or read
an existing dashboard database. Unexpected API requests and JavaScript runtime or
console errors fail the tests. The stream endpoint intentionally returns 404;
individual tests deliberately simulate specific service errors for recovery cases.
This scope does not validate provider integrations, Electron, or backend behavior.

Coverage includes desktop and 390/900px layouts, light/dark themes, sidebar and
drawer resizing and saved preferences, filter/context memory, command palette
search and branch steps, menus and date selection, asynchronous prompts, email
editing, chart tables, and nested overlay keyboard/focus behavior.

Failed runs preserve screenshots and traces in `test-results/`. Set
`PLAYWRIGHT_OUTPUT_DIR` to retain evidence outside the checkout. Selected successful
scenarios also save screenshots; each test attaches its runtime error summary.

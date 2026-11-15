# Repository Instructions

Do not create or update `.md` files unless the user explicitly asks you to.

Do not update the root `README.md` unless the user explicitly asks to update that file.
A general request to document behavior, configuration, or prerequisites does not authorize changes to the root `README.md`.

Do not create tests unless the user explicitly asks you to.

Do not create custom CLIs. Use existing tool CLIs and package scripts instead.

Keep pull request descriptions short and to the point, without fluff.

For Cloudflare Workers, pass structured objects directly to `console.error` and other console methods, for example `console.error({ event: 'request_failed', requestId })`.
Do not use `JSON.stringify` for log payloads; direct objects keep fields searchable in [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#logging-structured-json-objects).
Never log credentials, tokens, sensitive payloads, or unnecessary personal data.

Write readable, well-spaced code. Avoid dense one-liners, nested ternaries, and compressed control flow.
Use explicit control-flow blocks, descriptive intermediate variables where helpful, and blank lines between logical steps.
Do not sacrifice clarity to reduce the number of lines.

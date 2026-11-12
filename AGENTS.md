# Contributor and agent guidance

Read [CODEBASE.md](CODEBASE.md) before changing code. The current source and package scripts take precedence over historical plans.

Keep the shared architecture: one Spark model, instantiated for each configured unit. Adding a unit is a configuration change; do not duplicate collectors or methods per Spark number.

- Backend: plain JavaScript, ESM, no build step. Collectors live in `server/collectors/`; registry and polling live in `server/sparks/`.
- Frontend: TypeScript, React 19, Vite and Tailwind CSS v4. Use existing components, theme variables and stylesheet classes; avoid inline styles.
- Most HTTP routes live in `server/index.js`; existing feature modules register their own routes. Reuse those boundaries.
- Use camelCase for variables/functions and PascalCase for React components. Keep CSS class names kebab-case.
- Catch collector failures so polling continues. Preserve unknown or failed measurements instead of presenting them as healthy measured values.
- Keep runtime configuration, credentials, recordings and unrelated local changes out of commits. Use a separate worktree when the user's checkout is dirty.

Before submitting a change, run `npm run typecheck`, `npm run build`, and `npm test`. The server uses Node's built-in test runner; the frontend uses Vitest with jsdom. Add a regression for a corrected behavior and use isolated temporary configuration for server fixtures. Some hardware/shell-specific tests skip when prerequisites are unavailable.

The production server defaults to port 5555 and loopback binding; Vite uses 5173. Consult README for remote access, authentication and container configuration before changing deployment behavior. Production compose bind-mounts server code and `dist`; build the frontend on the host for frontend updates, without rebuilding the container for ordinary source changes.

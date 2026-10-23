# Contributing to Régis

Thanks for your interest!

## Before you start

- **Bugs**: open an issue with the *Bug report* form. Search existing issues first.
- **Features**: open an issue with the *Feature request* form, or start a
  [Discussion](https://github.com/chwazy/regis/discussions) for open-ended ideas. Agree on the approach
  before writing a large change.
- **Security issues**: never in a public issue — see [SECURITY.md](SECURITY.md).
- **Project rules**: [docs/architecture.md](docs/architecture.md) lists the design decisions, the
  conventions and the rules every change must respect (single SQLite owner in Rust, secrets only in the OS vault,
  every agent write goes through the tool policy, no audio sent to the cloud…). A change that breaks one of
  them will not be merged.
- **Visual changes**: reuse the existing components and the design tokens (`tokens.css`). UI labels
  are in French.

## Development setup

See [docs/development.md](docs/development.md). In short:

```bash
npm ci
npm run doctor
npm run dev:demo
```

## Pull request workflow

1. Fork the repository and create a branch from `main` (`feat/short-description`, `fix/short-description`).
2. Keep the change focused: one feature or fix per pull request.
3. Run the checks locally before pushing:

   ```bash
   npm run typecheck
   npm run lint
   npm test
   ```

4. Open the pull request against `main` and fill in the template. CI runs the same checks on Windows.
5. A maintainer reviews it. Address the comments with new commits; they are squashed when merging.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/). The pull request title becomes the
squashed commit, and it drives the changelog and the version number:

```
feat: add a weekly view to the brief
fix(sidecar): retry the Odoo sync after a timeout
docs: explain the Entra ID app registration
```

| Type | Use for | Version |
|---|---|---|
| `feat` | a user-visible feature | minor (patch before 1.0) |
| `fix` | a bug fix | patch |
| `docs`, `refactor`, `test`, `build`, `ci`, `chore` | everything else | none |

Add `!` after the type (`feat!:`) or a `BREAKING CHANGE:` footer for a breaking change.

## Tests

- New behaviour comes with tests: Vitest for TypeScript, `cargo test` for Rust. Parsing, mapping and rule
  functions are pure and unit tested.
- External formats (Claude Code CLI output, MCP and Odoo responses) are tested against captured fixtures in
  `tests/fixtures/`, never written from documentation.
- Never put a real secret, token or personal data in a fixture.

## Code of conduct

Everyone taking part in the project is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

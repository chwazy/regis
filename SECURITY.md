# Security Policy

## Reporting a vulnerability

**Please do not report security issues in public issues, discussions or pull requests.**

Report them privately through GitHub Security Advisories:
**[Report a vulnerability](https://github.com/chwazy/regis/security/advisories/new)**
(repository → *Security* tab → *Report a vulnerability*).

Please include:

- the affected version or commit;
- a description of the issue and its impact;
- the steps to reproduce it, or a proof of concept;
- any idea of a fix, if you have one.

## What to expect

Régis is maintained on a best-effort basis by volunteers.

- An acknowledgement within a few days.
- A first assessment and, if confirmed, a plan for a fix.
- A fix released as a new version, then a published advisory crediting you (unless you prefer to stay
  anonymous).

Please give us a reasonable time to release a fix before any public disclosure.

## Supported versions

Only the latest release receives security fixes.

## Scope

In scope: the Régis desktop app, its installer, its sidecar and its built-in MCP servers — for example a
way for an agent to bypass the tool policy, a secret written outside the OS vault, the local MCP server
reachable without its token, or a URL opened without validation.

Out of scope: vulnerabilities in third-party services and tools (Microsoft 365, Odoo, Anthropic, Ollama,
third-party MCP servers), and issues that require an already compromised user account or machine.

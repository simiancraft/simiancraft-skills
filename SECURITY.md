# Security Policy

## Reporting a vulnerability

If you find a security issue in any skill shipped by this repository, **please report it privately** rather than opening a public issue.

Preferred channel: open a [private security advisory](https://github.com/simiancraft/simiancraft-skills/security/advisories/new) on this repository. GitHub will notify the maintainer and route the conversation through the advisory.

Alternative: email `info@simiancraft.com` with the subject `[security] simiancraft-skills`.

Please include:
- The skill affected (e.g., `how-to-plan`).
- A minimal reproduction or threat model.
- The behavior you observed and what you expected.

You can expect an acknowledgement within 5 business days. We do not currently offer a bug bounty.

## Scope

This repository ships markdown methodology skills loaded into agent context. The relevant risk surfaces are:

- **Prompt-injection vectors** in skill content that could subvert host-agent behavior.
- **Supply-chain integrity** of the marketplace plugin (commits to `main` ship to every consumer).
- **Destructive instructions** in skill content that could trigger unsafe agent actions (file deletion, command execution, etc.).

Out of scope:
- Issues in Claude Code itself; report those to Anthropic.
- Issues in third-party tools the skills reference.

## Supported versions

This repository ships from `main`. We do not currently maintain back-port branches. The latest release tag (see [Releases](https://github.com/simiancraft/simiancraft-skills/releases)) reflects the canonical published version.

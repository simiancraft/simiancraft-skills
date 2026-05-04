# simiancraft-skills

Curated Claude Code skills and agents from [simiancraft](https://github.com/simiancraft).

This is a deliberately small, slow-growing marketplace plugin. Every skill in here is one we use in production and are willing to put the simiancraft name on; nothing makes it in for completeness or volume.

## Install

Add the marketplace and install the plugin in Claude Code:

```
/plugin marketplace add simiancraft/simiancraft-skills
/plugin install simiancraft-skills@simiancraft-skills
```

To update later:

```
/plugin marketplace update simiancraft-skills
```

## What's in here

| Skill | What it does |
|-------|--------------|
| [`how-to-plan`](skills/how-to-plan/SKILL.md) | Methodology for tactical, hand-off-ready planning docs. Goal-as-north-star, atomic commit steps with verification gates, before/after file trees, and the Inspector Gadget Rule (plans self-destruct when shipped, two-key handshake before deletion). |

## Contributing

This repo is curated, not crowdsourced. Issues and discussions are welcome (bug reports, behavior reports from real use, suggested clarifications). Pull requests for new skills will generally not be accepted; the bar is "skill we use in production," and someone else's production is not ours to vouch for.

If a skill in here helps you and you want to upstream a fix or clarification, open an issue first; we will tell you whether it is worth a PR.

## License

MIT. See [`LICENSE`](LICENSE).

# Vendored: last30days engine

- Upstream: https://github.com/mvanhorn/last30days-skill (MIT, see `LICENSE`)
- Version: 3.25.0, commit `084662b501fb0dba95bd55eff0c258d35e0dc499` (2026-09-22)
- Copied: `skills/last30days/{scripts,references}`, its `SKILL.md` renamed to
  `UPSTREAM-SKILL.md` (so it isn't registered as a second skill), and
  `.claude-plugin/plugin.json` (the engine reads its version from it).
  Demo media under `assets/` was dropped.
- Unmodified. NanoClaw integration lives one level up, in `../last30days`
  (launcher) and `../SKILL.md`.

Update: clone upstream on the host (in-container `git clone` fails behind the
gateway), then replace `scripts/`, `references/`, `UPSTREAM-SKILL.md`,
`LICENSE` and `.claude-plugin/plugin.json` here, and bump this file. The engine
needs Python 3.12+ and yt-dlp, both baked into the image (`container/Dockerfile`).

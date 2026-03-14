> Bindery web provides the canonical interactive view for pi packages; the CLI stays headless and automates installs, updates, and configuration edits.

# Pi Packages

Pi packages bundle extensions, skills, prompt templates, and themes so you can share them through npm or git. Declare resources in `package.json` under the `pi` key or rely on the conventional directories that both the web workspace and CLI scan.

## Table of Contents

- [Install and Manage](#install-and-manage)
- [Package Sources](#package-sources)
- [Creating a Pi Package](#creating-a-pi-package)
- [Package Structure](#package-structure)
- [Dependencies](#dependencies)
- [Package Filtering](#package-filtering)
- [Enable and Disable Resources](#enable-and-disable-resources)
- [Scope and Deduplication](#scope-and-deduplication)

## Install and Manage

> **Security:** Pi packages run with full system access. Review source code before installing third-party packages and keep installs scoped to repositories you trust.

```bash
pi install npm:@foo/bar@1.0.0
pi install git:github.com/user/repo@v1
pi install https://github.com/user/repo  # raw URLs work too
pi install /absolute/path/to/package
pi install ./relative/path/to/package

pi remove npm:@foo/bar
pi list    # show installed packages from settings
pi update  # update all non-pinned packages
```

Install and remove commands default to the global settings file at `~/.pi/agent/settings.json`. Pass `-l` to target the project scope (`.pi/settings.json`). Bindery web reads the same JSON files and lets you inspect the package list or flip toggles interactively while keeping the CLI and browser in sync.

To try a package without persisting it, use `pi -e` (or `pi --extension`). That loads the package in a temporary directory for just the current run:

```bash
pi -e npm:@foo/bar
pi -e git:github.com/user/repo
```

## Package Sources

Pi accepts three source types in settings and `pi install`.

### npm

```
npm:@scope/pkg@1.2.3
npm:pkg
```

- Versioned specs are pinned and skipped by `pi update`.
- Global installs use `npm install -g`.
- Project installs go under `.pi/npm/`.

### git

```
git:github.com/user/repo@v1
git:git@github.com:user/repo@v1
https://github.com/user/repo@v1
ssh://git@github.com/user/repo@v1
```

- Without the `git:` prefix, only protocol URLs (`https://`, `http://`, `ssh://`, `git://`) are accepted.
- The `git:` prefix unlocks shorthand formats such as `github.com/user/repo` and `git@github.com:user/repo`.
- HTTPS and SSH URLs are both supported.
- SSH URLs use your configured SSH keys automatically and respect `~/.ssh/config`.
- For CI, set `GIT_TERMINAL_PROMPT=0` to suppress credential prompts and adjust `GIT_SSH_COMMAND` (for example `ssh -o BatchMode=yes -o ConnectTimeout=5`) to fail fast.
- Refs pin the package and keep `pi update` from changing it.
- Clones land in `~/.pi/agent/git/<host>/<path>` (global) or `.pi/git/<host>/<path>` (project).
- If a `package.json` exists, pi runs `npm install` after clone or pull.

**SSH examples:**
```bash
# git@host:path shorthand (requires git: prefix)
pi install git:git@github.com:user/repo

# ssh:// protocol format
pi install ssh://git@github.com/user/repo

# With version ref
pi install git:git@github.com:user/repo@v1.0.0
```

### Local Paths

```
/absolute/path/to/package
./relative/path/to/package
```

Local paths point to files or directories on disk and are added to settings without copying. Relative paths resolve against the settings file that lists them. If the path is a file, pi loads it as a single extension; if it is a directory, pi applies the package rules.

## Creating a Pi Package

Add a `pi` manifest to `package.json` or rely on the conventional directories. Include the `pi-package` keyword so the gallery and workspace can discover it.

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Paths are relative to the package root. Arrays support glob patterns and `!` exclusions.

### Gallery Metadata

The [package gallery](https://shittycodingagent.ai/packages) displays packages tagged with `pi-package`. Add `video` or `image` fields to show a preview:

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

- **video**: MP4 only. On desktop it autoplays on hover and opens a fullscreen player when clicked.
- **image**: PNG, JPEG, GIF, or WebP displayed as a static preview.

If both are present, video takes precedence.

## Package Structure

### Convention Directories

When no `pi` manifest exists, pi auto-discovers resources from these directories:

- `extensions/` loads `.ts` and `.js` files.
- `skills/` recursively finds `SKILL.md` folders and loads top-level `.md` files as skills.
- `prompts/` loads `.md` files.
- `themes/` loads `.json` files.

## Dependencies

Third-party runtime dependencies belong in `dependencies` in `package.json`. Dependencies that do not register extensions, skills, prompt templates, or themes also belong in `dependencies`. When pi installs a package from npm or git, it runs `npm install`, so those dependencies are installed automatically.

Pi bundles a small set of runtime helpers for extensions and skills. If you import any of these, declare them in `peerDependencies` with a "*" range and do not bundle them: `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-coding-agent`, `@sinclair/typebox`.

Other pi packages must be bundled in your tarball. Add them to `dependencies` and `bundledDependencies`, then reference their resources through `node_modules/` paths. Pi loads packages with separate module roots, so separate installs do not collide or share modules.

Example:

```json
{
  "dependencies": {
    "shitty-extensions": "^1.0.1"
  },
  "bundledDependencies": ["shitty-extensions"],
  "pi": {
    "extensions": ["extensions", "node_modules/shitty-extensions/extensions"],
    "skills": ["skills", "node_modules/shitty-extensions/skills"]
  }
}
```

## Package Filtering

Filter what a package loads using the object form in settings:

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"]
    }
  ]
}
```

`+path` and `-path` are exact paths relative to the package root.

- Omit a key to load all of that type.
- Use `[]` to load none of that type.
- `!pattern` excludes matches.
- `+path` force-includes an exact path.
- `-path` force-excludes an exact path.
- Filters layer on top of the manifest. They narrow down what is already allowed.

## Enable and Disable Resources

Bindery web surfaces resource toggles that write back to the same JSON settings files the CLI uses (`~/.pi/agent/settings.json` and `.pi/settings.json`). To restrict extensions, skills, prompts, or themes from a package, update the `packages` array or its filter objects in the JSON directly, or flip the toggles in Bindery web so both surfaces stay synchronized.

Use the `packages` entries to add `extensions`, `skills`, `prompts`, or `themes` arrays, or to set them to `[]` when nothing should load. The CLI and web workspace load those filters before instantiating resources.

## Scope and Deduplication

Packages can appear in both global and project settings. If the same package appears in both, the project entry wins. Identity is determined by:

- npm: package name
- git: repository URL without ref
- local: resolved absolute path

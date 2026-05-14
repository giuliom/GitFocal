# GitFocal

[![Package VSIX](https://github.com/giuliom/GitFocal/actions/workflows/package.yml/badge.svg)](https://github.com/giuliom/GitFocal/actions/workflows/package.yml)

<img src="assets/icon.png" alt="GitFocal icon" width="128" />

A no-frills Visual Studio Code extension for Git. GitFocal adds three focused views to the Source Control sidebar: **Branches**, **Stashes**, and **Tags**. It shells out to your local `git`, keeps runtime dependencies at zero, and is written in JavaScript.

## Features

### Branches view

- Lists local branches with current-branch indicator, ahead/behind counts, and upstream info
- Worktrees are grouped when more than one is present
- Expanding a branch shows recent commits
- Inline actions: checkout, fetch, pull, push, publish branch, reset current branch
- Context menu: create from, rename, delete (with force), merge, rebase, squash, reset, change upstream, copy branch name/upstream/commit hash
- Commit actions: cherry-pick, create tag at commit, copy commit hash
- Toggle to hide submodule repositories from the Branches view

### Stashes view

- Lists stashes per repository and expands each stash to show changed files
- Apply, pop, rename, and delete stashes
- Restore an individual file from a stash
- Stash changes from the view title or stash all / staged / unstaged changes from SCM resource menus
- Toggle to hide submodule repositories from the Stashes view

### Tags view

- Lists tags per repository with commit/date details and annotated-tag indicator
- Create lightweight or annotated tags at `HEAD`, another ref, or directly from a branch commit
- Checkout, rename, delete, push, and delete remote tags
- Copy tag name or tagged commit hash

### Top-level behavior

- View title commands for refresh, create branch, stash changes, create tag, and fetch all repositories
- Auto-fetch on a configurable interval (default 5 min)
- Auto-detects `git` or accepts an explicit path via `gitfocal.gitPath`

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `gitfocal.refreshDebounceMs` | `500` | Debounce delay (ms) for filesystem-watcher refreshes |
| `gitfocal.autoFetchIntervalMinutes` | `5` | Interval for `git fetch --all --prune`. `0` disables |
| `gitfocal.gitPath` | `""` | Optional explicit path to the `git` executable |

## Keybindings

| Command | Shortcut |
| --- | --- |
| Refresh focused GitFocal view | `Ctrl+Alt+R` / `Cmd+Alt+R` |
| Fetch all repositories from Branches view | `Ctrl+Alt+F` / `Cmd+Alt+F` |

## Building the VSIX

GitFocal has no transpile step. The extension runs directly from `src/`, and packaging is done with [`@vscode/vsce`](https://github.com/microsoft/vscode-vsce).

### Prerequisites

- `git` on `PATH`
- [Node.js](https://nodejs.org/) 18+ for `npx`, or [Deno](https://deno.com/) for the alternate packaging command

### Package

```sh
npx @vscode/vsce package -o build
```

Alternative with Deno:

```sh
deno run -A npm:@vscode/vsce package -o build --no-dependencies
```

The resulting `gitfocal-<version>.vsix` is written to the `build/` directory.

You can also run the bundled VS Code tasks:

- **Terminal → Run Task… → create-package**
- **Terminal → Run Task… → create-package-deno**

### Install the VSIX locally

```sh
code --install-extension build/gitfocal-<version>.vsix
```

### CI

`.github/workflows/package.yml` builds the VSIX on push, PR, and tag, and uploads it as a workflow artifact.

## Project Layout

```
src/
  extension.js              # activation entry point
  commands/                 # command handlers
  git/                      # git CLI wrapper + types
  models/                   # state, preferences, repository state
  providers/                # tree data providers (branches, stashes)
  ui/                       # icons, decorations
  utils/                    # debounce, git path resolver
```

## TODO

- [ ] Better support for worktrees and submodules
- [ ] Diff viewer integration for stashes
- [ ] Group local branches by prefix (`feature/`, `fix/`, …)
- [ ] Optional remote branches view (currently hidden)
- [ ] Unit tests for `gitService` and providers
- [ ] Publish to the VS Code Marketplace

## License

See [LICENSE](LICENSE).


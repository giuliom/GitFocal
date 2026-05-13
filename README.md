# GitFocal

<img src="assets/icon.png" alt="GitFocal icon" width="128" />

A no-frills Visual Studio Code extension for Git. GitFocal adds two focused views to the Source Control side bar — **Branches** and **Stashes** — with zero runtime dependencies (it shells out to your local `git`).

## Features

- **Branches view** in the SCM side bar
  - Lists local branches with current-branch indicator, ahead/behind counts, and upstream info
  - Worktrees are grouped when more than one is present
  - Inline actions: checkout, fetch, pull, push, publish branch
  - Context menu: create from, rename, delete (with force), merge, rebase, squash, reset, change upstream, copy name/upstream/commit hash
  - Toggle to hide submodule branches
- **Stashes view** in the SCM side bar
  - List, apply, pop, rename, delete stashes
  - Stash all / staged / unstaged changes from the SCM resource menus
- **Top-level commands**: refresh, create branch, fetch all
- **Auto-fetch** on a configurable interval (default 5 min)
- **Auto-detects** `git` or accepts an explicit path via `gitfocal.gitPath`

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `gitfocal.refreshDebounceMs` | `500` | Debounce delay (ms) for filesystem-watcher refreshes |
| `gitfocal.autoFetchIntervalMinutes` | `5` | Interval for `git fetch --all --prune`. `0` disables |
| `gitfocal.gitPath` | `""` | Optional explicit path to the `git` executable |

## Keybindings

| Command | Shortcut |
| --- | --- |
| Refresh | `Ctrl+Alt+R` / `Cmd+Alt+R` (when a GitFocal view is focused) |
| Fetch All | `Ctrl+Alt+F` / `Cmd+Alt+F` (when Branches is focused) |

## Building the VSIX

GitFocal has no build step — the extension runs directly from `src/`. Packaging is done with [`@vscode/vsce`](https://github.com/microsoft/vscode-vsce) via `npx`.

### Prerequisites

- `git` on `PATH`
- [Node.js](https://nodejs.org/) 18+ (for `npx`, only needed to create a package locally)

### Package

```sh
npx @vscode/vsce package -o build
```

The resulting `gitfocal-<version>.vsix` is written to the `build/` directory.

You can also run the bundled VS Code task:

- **Terminal → Run Task… → create-package**

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

- [ ] Commit list for branches
- [ ] Better support for worktrees and submodules
- [ ] Diff viewer integration for stashes
- [ ] Cherry-pick command
- [ ] Tag management view
- [ ] Group local branches by prefix (`feature/`, `fix/`, …)
- [ ] Optional remote branches view (currently hidden)
- [ ] Unit tests for `gitService` and providers
- [ ] Publish to the VS Code Marketplace

## License

See [LICENSE](LICENSE).


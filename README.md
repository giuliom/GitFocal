# GitFocal

[![Package VSIX](https://github.com/giuliom/GitFocal/actions/workflows/package.yml/badge.svg)](https://github.com/giuliom/GitFocal/actions/workflows/package.yml)
[![CodeQL Advanced](https://github.com/giuliom/GitFocal/actions/workflows/codeql.yml/badge.svg)](https://github.com/giuliom/GitFocal/actions/workflows/codeql.yml)


<img src="assets/icon.png" alt="GitFocal icon" width="128" />

A no-frills Visual Studio Code extension for Git. GitFocal adds four focused views to the Source Control sidebar: **Branches**, **Remotes**, **Stashes**, and **Tags**. It shells out to your local `git`, keeps runtime dependencies at zero, and is written in JavaScript.


<img src="assets/screenshot.png" alt="GitFocal screenshot" width="512" />

## Features

### Branches view

- Lists local branches with current-branch indicator, ahead/behind counts, and upstream info
- Worktrees are grouped when more than one is present
- Expanding a branch shows recent commits
- Inline actions: checkout, fetch, pull, push, publish branch, reset current branch
- Context menu: create from, rename, delete (with force), merge, rebase, squash, reset, change upstream, copy branch name/upstream/commit hash
- Commit actions: cherry-pick, create tag at commit, copy commit hash
- Toggle to hide submodule repositories from the Branches view

### Remotes view

- Groups remote-tracking branches by remote and shows recent commits for each branch
- Filter remote branches by name from the view title
- Checkout a remote branch as a new local branch or create a local branch from it
- Fetch a specific remote, add remotes, and copy remote names or URLs
- Branch actions include merge, rebase, cherry-pick, reset, tag-at-commit, and copy commit hash
- Toggle to hide submodule repositories from the Remotes view

### Stashes view

- Lists stashes per repository and expands each stash to show changed files
- Open diffs, apply, pop, rename, and delete stashes
- Restore an individual file from a stash
- Stash changes from the view title or stash all / staged / unstaged / selected changes from SCM resource menus
- Toggle to hide submodule repositories from the Stashes view

### Tags view

- Lists tags per repository with commit/date details, annotated-tag indicator, and origin sync status
- Filter tags by name from the view title
- Create lightweight or annotated tags at `HEAD`, another ref, or directly from a branch commit
- Checkout, rename, delete, and delete remote tags
- Push tags when they are missing on `origin` or point to a different commit there; matching tags are shown as already synced
- Copy tag name or tagged commit hash

### Shared behavior

- View title commands for refresh, create branch, add remote, stash changes, create tag, and fetch all repositories
- Focused refresh and fetch-all keybindings for the SCM views
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
  commands/                 # command handlers for tree items and view titles
  git/                      # git CLI wrapper + types
  models/                   # state, preferences, repository state
  providers/                # tree data providers (branches, remotes, stashes, tags)
  ui/                       # icons and decorations
  utils/                    # debounce, git path resolver, repo filters
```

## TODO

- [ ] Better support for worktrees and submodules
- [ ] Group local branches by prefix (`feature/`, `fix/`, …)
- [ ] Unit tests for `gitService` and providers
- [ ] Publish to the VS Code Marketplace

## License

See [LICENSE](LICENSE).


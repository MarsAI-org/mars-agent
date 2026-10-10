# Credits

Mars is a fork of oh-my-pi by can1357, which is a fork of Pi by Mario Zechner. Both are MIT licensed.

## Upstream

- [oh-my-pi](https://github.com/can1357/oh-my-pi) by [can1357](https://github.com/can1357) — the base this fork is derived from.
  Licensed under the MIT License.
- [Pi](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://github.com/mariozechner) — the original project that oh-my-pi forked.
  Licensed under the MIT License.

The copyright notices of both upstream projects are preserved in
[LICENSE](./LICENSE), alongside the Mars copyright line.

## Vendored and third-party code

Parts of this repository build on third-party open source, in particular:

- `crates/vendor/brush-core` — a vendored, locally patched copy of the
  [brush](https://github.com/reubeno/brush) shell.
- The command-line utilities in `crates/pi-builtins`, whose upstream
  attribution and license terms are recorded in `crates/pi-builtins/LICENSE`.
- The Rust and JavaScript dependencies pulled in by the workspace.

See [THIRD-PARTY-NOTICES.txt](./THIRD-PARTY-NOTICES.txt) and the component-local
notice files for the full attribution and the terms that apply.

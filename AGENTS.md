# Agent instructions

## Versioning the npm package

The terminal ASCII view is published to npm as `3d-ascii`, so `npx 3d-ascii` runs it. Its version is the `version` field in `npm/package.json`. The root `package.json` is the private web app and has no version to bump.

Bump the version only when a change reaches the published bundle: `cli/` or any code in `app/` that `cli/` imports (environments, players, the ray tracer, lighting). Changes that only affect the web app (Vue components, pages, three.js, WebGPU) do not need a release.

Follow [semantic versioning](https://semver.org). The package's public interface is what a user of `npx 3d-ascii` sees: command-line arguments and options, keys and mouse controls, what a given `--seed` generates, and the minimum Node version in `engines`.

- **Major** (`1.4.2` → `2.0.0`): something that worked stops working or does something else. A removed or renamed option, environment or key; a raised minimum Node version; the same seed generating a different world.
- **Minor** (`1.4.2` → `1.5.0`): something new, and everything that worked before still does. A new environment, player, option or key; a new rendering mode.
- **Patch** (`1.4.2` → `1.4.3`): fixes and speedups that don't change the interface. A bug fix, faster tracing, a better fallback for a terminal.

While the version is `0.x`, breaking changes bump the minor version (`0.3.1` → `0.4.0`) and everything else bumps the patch. Go to `1.0.0` when the options and seeds are considered stable.

If several changes go into one release, use the largest bump among them.

## Releasing

1. Set the new `version` in `npm/package.json`.
2. Run `yarn build:cli` and `yarn typecheck`.
3. Run `npm pack` in `npm/` and check that `npx --package=./3d-ascii-X.Y.Z.tgz 3d-ascii` starts and draws frames. Delete the `.tgz` afterwards.
4. Commit the version change on its own: `Release 3d-ascii X.Y.Z`.
5. Tag that commit `3d-ascii-vX.Y.Z`.
6. Leave `npm publish` (run from `npm/`) and pushing to the maintainer unless they ask you to do them. A published version can't be republished.

# Versioning

`npm/package.json` holds the version of the `3d-ascii` npm package. Bump it with semver when a change affects `cli/` or the `app/` code it imports.

Release: bump, `yarn build:cli`, commit `Release 3d-ascii X.Y.Z`. The maintainer runs `npm publish` from `npm/`.

# Third-party notices

- Node.js runtime and `node:sqlite` are provided by Node.js. The deployed runtime uses the fixed Node release selected by the repository tooling.
- TypeScript is a development-only dependency used for `npm run typecheck`; it is not loaded by the production service as a package.
- `@types/node` is a development-only type declaration package matching the Node 24 runtime APIs.
- The Hub remains an external Token Monitor service. Its API and worker sources are referenced through `external/token-monitor`; they are not bundled into Analytics.

The release archive contains no Hub credentials, database, local configuration, development dependency tree, or source checkout.

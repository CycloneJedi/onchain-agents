# Live dashboard build

`live/index.html` loads `live/dashboard.js`. Edit `live/dashboard.mjs`, then from the repository root:

    npm ci
    npm run build:live

`npm ci` installs the lockfile. `npm run check:live` runs the read-only dashboard checks. The build bundles viem 2.38.3 (MIT) for the browser. The bundle is read-only: public RPC calls only, with no wallet and no signing. License notices for viem and the libraries it pulls in are written at the end of `live/dashboard.js`. A rebuild from this lockfile must match the committed `live/dashboard.js`.

Do not commit `node_modules`.

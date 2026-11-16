// Browser entry: one platform client and one live connection per tab, then
// the sign-in check (M2-14) and the app.

import { createRoot } from 'react-dom/client';

import type { ConnectionState } from './data/live-connection.js';
import { LiveConnection, browserSocket } from './data/live-connection.js';
import { PlatformClient, storedToken } from './data/platform-client.js';
import { App } from './ui/App.js';
import { AuthGate } from './ui/AuthGate.js';
import type { StateSource } from './ui/App.js';

let state: ConnectionState = 'connecting';
const watchers = new Set<() => void>();
const connection: StateSource = {
  get: () => state,
  subscribe: (watcher) => {
    watchers.add(watcher);
    return () => watchers.delete(watcher);
  },
};

const client = new PlatformClient({ token: storedToken, origin: window.location.origin });
const live = new LiveConnection({
  url: () => client.liveUrl(),
  open: browserSocket,
  timers: { set: (run, ms) => window.setTimeout(run, ms), clear: (handle) => window.clearTimeout(handle as number) },
  onState: (next) => {
    state = next;
    for (const watcher of watchers) watcher();
  },
});

const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(<AuthGate client={client}>{(session) => <App client={client} live={live} connection={connection} session={session} />}</AuthGate>);
}

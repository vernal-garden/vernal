import { ConfigError, loadServerConfig } from './lib/serverConfig';

// Side-effect module: imported right after './instrument' (which loads dotenv)
// so a bad configuration stops the process before anything else initialises.
// ES imports hoist, so this cannot be a plain call in index.ts.
try {
  loadServerConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

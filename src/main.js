import { readConfig } from './config.js';
import { createAnalytics } from './app.js';

let app;
try {
  const config = readConfig();
  app = createAnalytics(config);
  await app.start();
  console.log(`Token Monitor Analytics: http://${config.host}:${config.port}`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      await app.close();
      process.exitCode = 0;
    });
  }
} catch (error) {
  // Configuration errors are deliberate messages without input values.
  const secrets = [process.env.HUB_SECRET, process.env.BASIC_PASSWORD].filter(Boolean);
  console.error(secrets.reduce((message, secret) => message.replaceAll(secret, '[redacted]'), error.message));
  if (app) await app.close();
  process.exitCode = 1;
}

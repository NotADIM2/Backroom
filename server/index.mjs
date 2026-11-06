import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.BACKROOM_PORT ?? 4600);

// The key lives only in this process and its terminal, so agents using the tool never receive it.
const approverKey = randomBytes(18).toString('base64url');

const server = createApp({
  rootDir,
  statePath: join(rootDir, 'data', 'runtime', 'state.json'),
  approverKey,
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Is Backroom already running?`);
    process.exit(1);
  }
  throw error;
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Backroom is running on http://localhost:${port}`);
  console.log('');
  console.log('Open this private link to sign off on cases. Keep it out of the room:');
  console.log(`http://localhost:${port}/#key=${approverKey}`);
  console.log('');
  console.log('The link changes each time the server starts.');
  openInBrowser(`http://localhost:${port}/#key=${approverKey}`);
});

function openInBrowser(url) {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => console.log("Couldn't open your browser, so open the link above yourself."));
  child.unref();
}

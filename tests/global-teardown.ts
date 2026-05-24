import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';

// Stops the server started by global-setup.ts.
const PID_FILE = join(process.cwd(), 'tests', '.server.pid');

async function globalTeardown() {
  if (!existsSync(PID_FILE)) return;
  const pid = parseInt(readFileSync(PID_FILE, 'utf8'), 10);
  if (!Number.isNaN(pid)) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
  try {
    unlinkSync(PID_FILE);
  } catch {
    // ignore
  }
}

export default globalTeardown;

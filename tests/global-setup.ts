import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';

// Playwright launches a configured `webServer` BEFORE globalSetup runs, which
// would lock test.db before we could wipe it. So instead we own the lifecycle
// here: wipe the isolated DB while nothing holds it, then start the server with
// test env vars. tests/global-teardown.ts stops it. Node fs/child_process only,
// so it behaves identically in Git Bash, cmd and PowerShell.

const PORT = 3099;
const ROOT = process.cwd();
const PID_FILE = join(ROOT, 'tests', '.server.pid');

const TEST_ENV = {
  PORT: String(PORT),
  APP_URL: `http://localhost:${PORT}`,
  TURSO_DATABASE_URL: 'file:./test.db',
  TURSO_AUTH_TOKEN: '',
  JWT_SECRET: 'test-jwt-secret-do-not-use-in-prod',
  RESEND_API_KEY: '',
  EMAIL_FROM: 'Teamly Test <noreply@test.local>',
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'Admin@123!',
  RATE_LIMIT_MAX: '100000',
};

async function globalSetup() {
  await wipeDb();
  await startServer();
}

async function wipeDb() {
  for (const name of ['test.db', 'test.db-wal', 'test.db-shm', 'test.db-journal']) {
    await removeWithRetry(join(ROOT, name));
  }
}

async function removeWithRetry(file: string, attempts = 15): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      if (existsSync(file)) unlinkSync(file);
      return;
    } catch (err: any) {
      if (err?.code === 'ENOENT') return;
      if ((err?.code === 'EBUSY' || err?.code === 'EPERM') && i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      throw err;
    }
  }
}

async function startServer() {
  // dotenv in server.js does NOT override already-set env vars, so these win
  // over anything in a real .env (keeps the dev DB untouched).
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...TEST_ENV },
    stdio: 'inherit',
  });
  writeFileSync(PID_FILE, String(child.pid));
  child.unref();
  await waitForHealth();
}

async function waitForHealth() {
  const url = `http://localhost:${PORT}/health`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Test server did not respond on /health within 60s');
}

export default globalSetup;

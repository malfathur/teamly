// Cross-platform launcher for demo mode: sets DEMO_MODE before booting the
// server, so `npm run demo` works identically in Git Bash, cmd and PowerShell
// (no shell-specific env syntax needed).
process.env.DEMO_MODE = 'true';
require('./server.js');

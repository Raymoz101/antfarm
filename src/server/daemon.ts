#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startDashboard } from "./dashboard.js";
import { installMedicCron } from "../medic/medic-cron.js";

const port = parseInt(process.argv[2], 10) || 3333;

const pidDir = path.join(os.homedir(), ".openclaw", "antfarm");
const pidFile = path.join(pidDir, "dashboard.pid");

fs.mkdirSync(pidDir, { recursive: true });
fs.writeFileSync(pidFile, String(process.pid));

process.on("SIGTERM", () => {
  try { fs.unlinkSync(pidFile); } catch {}
  process.exit(0);
});

startDashboard(port);

// Ensure medic cron is installed (idempotent — no-op if already present).
// Runs after startDashboard so the dashboard is up even if this fails.
installMedicCron().catch(() => { /* best-effort — cron can be installed manually */ });

import { defineConfig, devices } from "@playwright/test";


const backendCommand = [
  "cd ../backend",
  "PYTHON_BIN=\"${PYTHON:-}\"",
  "if [ -z \"$PYTHON_BIN\" ]; then " +
    "if [ -x .venv/bin/python ]; then PYTHON_BIN=.venv/bin/python; " +
    "elif [ -x ../venv/bin/python ]; then PYTHON_BIN=../venv/bin/python; " +
    "elif command -v python3 >/dev/null 2>&1; then PYTHON_BIN=python3; " +
    "else PYTHON_BIN=python; fi; " +
  "fi",
  "SERVER_IP=127.0.0.1 SERVER_DOMAIN=localhost TURN_SECRET=test-secret " +
    "TURN_REALM=localhost FRONTEND_ORIGIN=http://127.0.0.1:5173 " +
    "MAX_SESSIONS=20 SESSIONS_RATE_LIMIT=1000/minute TURN_CRED_TTL=3600 " +
    "\"$PYTHON_BIN\" -m uvicorn main:app --host 127.0.0.1 --port 8000",
].join(" && ");


export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: {
    timeout: 20_000,
  },
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: backendCommand,
      url: "http://127.0.0.1:8000/api/ice-config",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: "npm run dev -- --host 127.0.0.1 --port 5173",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});

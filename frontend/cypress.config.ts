import { defineConfig } from "cypress";
import WebSocket from "ws";

interface WsMsg {
  type: string;
  payload?: Record<string, unknown>;
}

let p2Socket: WebSocket | null = null;
let p2TextQueue: WsMsg[] = [];
let p2BinaryQueue: Buffer[] = [];
let p2Closed = false;

function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 10000,
  errorMsg = "Timed out waiting for condition"
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        reject(new Error(errorMsg));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

export default defineConfig({
  allowCypressEnv: false,
  e2e: {
    baseUrl: "http://127.0.0.1:8000",
    specPattern: "cypress/e2e/**/*.cy.ts",
    supportFile: "cypress/support/e2e.ts",
    video: false,
    screenshotOnRunFailure: true,
    defaultCommandTimeout: 10000,
    setupNodeEvents(on) {
      on("task", {
        p2Connect(wsUrl: string) {
          return new Promise((resolve, reject) => {
            if (p2Socket) {
              try {
                p2Socket.terminate();
              } catch {
                // ignore
              }
            }
            p2TextQueue = [];
            p2BinaryQueue = [];
            p2Closed = false;

            const ws = new WebSocket(wsUrl);
            p2Socket = ws;

            ws.on("open", () => resolve(true));
            ws.on("error", (err) => reject(err));
            ws.on("close", () => {
              p2Closed = true;
            });
            ws.on("message", (data, isBinary) => {
              if (isBinary) {
                const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
                p2BinaryQueue.push(buf);
              } else {
                try {
                  const parsed = JSON.parse(data.toString()) as WsMsg;
                  p2TextQueue.push(parsed);
                } catch {
                  // ignore non-JSON
                }
              }
            });
          });
        },

        p2Send(msg: WsMsg) {
          if (!p2Socket || p2Socket.readyState !== WebSocket.OPEN) {
            throw new Error("Player 2 WebSocket is not open");
          }
          p2Socket.send(JSON.stringify(msg));
          return true;
        },

        async p2WaitForEvent({ type, timeoutMs = 10000 }: { type: string; timeoutMs?: number }) {
          let found: WsMsg | null = null;
          await waitForCondition(
            () => {
              const idx = p2TextQueue.findIndex((m) => m.type === type);
              if (idx !== -1) {
                found = p2TextQueue.splice(idx, 1)[0];
                return true;
              }
              return false;
            },
            timeoutMs,
            `Player 2 did not receive event "${type}" within ${timeoutMs}ms (received: ${p2TextQueue.map((m) => m.type).join(", ")})`
          );
          return found;
        },

        async p2WaitForBinary(timeoutMs = 10000) {
          let found: number[] | null = null;
          await waitForCondition(
            () => {
              if (p2BinaryQueue.length > 0) {
                const buf = p2BinaryQueue.shift()!;
                found = Array.from(buf);
                return true;
              }
              return false;
            },
            timeoutMs,
            "Player 2 did not receive binary drawing frame"
          );
          return found;
        },

        p2Status() {
          return {
            closed: p2Closed,
            readyState: p2Socket ? p2Socket.readyState : -1,
            eventsReceived: p2TextQueue.map((m) => m.type),
            binaryCount: p2BinaryQueue.length,
          };
        },

        p2Close() {
          if (p2Socket) {
            try {
              p2Socket.terminate();
            } catch {
              // ignore
            }
            p2Socket = null;
          }
          p2TextQueue = [];
          p2BinaryQueue = [];
          p2Closed = false;
          return true;
        },
      });
    },
  },
});

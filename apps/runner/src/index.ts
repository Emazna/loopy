import { dirname } from "node:path";
import { createDefaultWorkflow } from "@emazna/loop-runtime";
import { LoopStore } from "@emazna/loop-storage";
import { LoopRunner } from "./runtime.js";
import { RunnerLock } from "./runner-lock.js";

const store = new LoopStore();
const lock = new RunnerLock(`${store.path}.runner.lock`);
lock.acquire();

const defaultCwd = process.env.LOOP_CANVAS_WORKDIR ?? process.cwd();
const defaultModel = process.env.LOOP_CANVAS_MODEL ?? "gpt-5.4";
store.ensureWorkflow(createDefaultWorkflow(defaultCwd, defaultModel));

const runner = new LoopRunner(store);
runner.start();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  store.setMeta("runner_last_signal", signal);
  await runner.stop();
  lock.release();
  store.close();
}

process.on("SIGINT", () => void shutdown("SIGINT").finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown("SIGTERM").finally(() => process.exit(0)));
process.on("exit", () => lock.release());

store.setMeta("runner_runtime_dir", dirname(store.path));

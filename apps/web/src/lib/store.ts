import { createDefaultWorkflow } from "@emazna/loop-runtime";
import { getLoopStore } from "@emazna/loop-storage";

export function appStore() {
  const store = getLoopStore();
  const cwd = process.env.LOOP_CANVAS_WORKDIR ?? process.cwd();
  const model = process.env.LOOP_CANVAS_MODEL ?? "gpt-5.4";
  store.ensureWorkflow(createDefaultWorkflow(cwd, model));
  return store;
}

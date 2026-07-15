import { createDefaultWorkflow } from "@emazna/loop-runtime";
import { getLoopStore } from "@emazna/loop-storage";

export function appStore() {
  const store = getLoopStore();
  // ワークフローが1つも無いときだけ、既定のサンプルを用意する。
  // （削除したワークフローが勝手に復活しないよう、常時ensureはしない）
  if (store.listWorkflows().length === 0) {
    const cwd = process.env.LOOP_CANVAS_WORKDIR ?? process.cwd();
    const model = process.env.LOOP_CANVAS_MODEL ?? "gpt-5.4";
    store.ensureWorkflow(createDefaultWorkflow(cwd, model));
  }
  return store;
}

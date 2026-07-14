import { LoopStore } from "./store";

const globalStore = globalThis as typeof globalThis & { __emaznaLoopStore?: LoopStore };

export function getLoopStore(): LoopStore {
  if (!globalStore.__emaznaLoopStore) {
    globalStore.__emaznaLoopStore = new LoopStore();
  }
  return globalStore.__emaznaLoopStore;
}

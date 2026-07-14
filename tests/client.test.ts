import { describe, expect, it } from "vitest";
import { CodexAppServerClient } from "@emazna/codex-app-server-adapter";

describe("Codex App Server client lifecycle", () => {
  it("rejects an outstanding turn waiter when the client closes", async () => {
    const client = new CodexAppServerClient();
    const waiter = client.waitForTurn("thread", "turn", 60_000);
    const rejection = expect(waiter).rejects.toThrow("client closed");

    await client.close();

    await rejection;
  });
});

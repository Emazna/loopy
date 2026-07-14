import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

export class RunnerLock {
  private fd: number | null = null;

  constructor(private readonly path: string) {}

  acquire(): void {
    try {
      this.fd = openSync(this.path, "wx");
    } catch (error) {
      let existingPid = 0;
      try {
        existingPid = Number(readFileSync(this.path, "utf8").trim());
      } catch {
        // Treat unreadable lock as active instead of deleting it blindly.
      }
      if (existingPid > 0 && !this.isAlive(existingPid)) {
        unlinkSync(this.path);
        this.fd = openSync(this.path, "wx");
      } else {
        throw new Error(`Another Loop Canvas runner appears active (pid ${existingPid || "unknown"}).`, { cause: error });
      }
    }
    writeFileSync(this.fd, String(process.pid), "utf8");
  }

  release(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
    try {
      unlinkSync(this.path);
    } catch {
      // The lock may already have been cleaned up by process shutdown.
    }
  }

  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

import { promises as fs } from "node:fs";
import path from "node:path";

// Local asset storage (plan.md §4): writes under <project-root>/data/uploads. If a self-hoster ever
// needs S3/MinIO/R2, swap this module's implementation behind the same put/get/delete surface.
class LocalStorage {
  private root = path.join(process.cwd(), "data");

  private full(key: string) {
    // key is always a relative posix-ish path like "uploads/<id>.png"
    return path.join(this.root, key);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const target = this.full(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.full(key));
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.full(key), { force: true });
  }
}

let driver: LocalStorage | null = null;

export function getStorage(): LocalStorage {
  return (driver ??= new LocalStorage());
}

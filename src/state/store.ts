import { promises as fs } from "fs";
import path from "path";

export type WalletState = Record<string, string | null>;

export class StateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<WalletState> {
    try {
      const data = await fs.readFile(this.filePath, "utf-8");
      return JSON.parse(data) as WalletState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  async save(state: WalletState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(state, null, 2));
  }
}

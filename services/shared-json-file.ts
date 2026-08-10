import { randomBytes } from "crypto";
import { chmodSync, renameSync, rmSync, writeFileSync } from "fs";

const SHARED_FILE_MODE = 0o660;

/** Atomically replace JSON that is shared by the letyclaw and webhook service users. */
export function atomicWriteSharedJson(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;

  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: SHARED_FILE_MODE });
    // writeFile's mode is masked by the process umask. The bot runs with 0022,
    // so enforce group write before publishing the temporary file.
    chmodSync(temporary, SHARED_FILE_MODE);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

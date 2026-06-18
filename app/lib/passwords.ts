import { verify } from "@node-rs/argon2";

// argon2id (library defaults are argon2id with sane params).
export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  try {
    return await verify(hashed, password);
  } catch {
    return false;
  }
}

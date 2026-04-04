import pkg from 'bcryptjs';
const { hashSync, compareSync } = pkg;

export function hashPassword(password: string): string {
  return hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string): boolean {
  return compareSync(password, hash);
}

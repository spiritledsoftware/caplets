import { randomBytes } from "node:crypto";

const PAIRING_CODE_PREFIX = "cap_pair";

export type ParsedPairingCode = {
  codeId: string;
  secret: string;
};

export function createPairingCode(): { codeId: string; code: string; secret: string } {
  const codeId = randomPairingPart(8);
  const secret = randomPairingPart(24);
  return { codeId, secret, code: createPairingCodeVerifier(codeId, secret) };
}

export function createPairingCodeVerifier(codeId: string, secret: string): string {
  return `${PAIRING_CODE_PREFIX}_${codeId}_${secret}`;
}

export function parsePairingCode(value: string): ParsedPairingCode | undefined {
  const match = value.match(/^cap_pair_([0-9A-Za-z_-]{8,})_([0-9A-Za-z_-]{24,})$/u);
  if (!match?.[1] || !match[2]) return undefined;
  return { codeId: match[1], secret: match[2] };
}

export function isPairingCodeFormat(value: string): boolean {
  return parsePairingCode(value) !== undefined;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function randomPairingPart(bytes: number): string {
  return randomToken(bytes).replaceAll("_", "-");
}

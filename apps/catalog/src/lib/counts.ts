export function rankInstallCount(count: number): number {
  if (!Number.isFinite(count) || count < 10) {
    return 0;
  }
  return Math.floor(count);
}

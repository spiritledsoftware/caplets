export function decodeEntryRouteKey(value: string): string {
  return value.replace(/%3A/giu, ":").replace(/%25/giu, "%");
}

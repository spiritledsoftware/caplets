declare module "@hugeicons/core-free-icons/*" {
  type IconNode = readonly [string, Readonly<Record<string, string | number>>];
  const icon: readonly IconNode[];
  export default icon;
}

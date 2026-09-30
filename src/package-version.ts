/** Reads the package version used in CLI output and import metadata. */
export async function readPackageVersion(): Promise<string> {
  const manifest = await Bun.file(new URL('../package.json', import.meta.url)).json() as { version?: unknown; };
  if (typeof manifest.version !== 'string' || !manifest.version) {
    throw new Error('package.json has no valid version');
  }
  return manifest.version;
}

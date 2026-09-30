import {
  afterEach,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import packageJson from '../package.json';
import { readPackageVersion } from '../src/package-version.ts';
import { captureRejection } from './assertions.ts';

afterEach(() => mock.restore());

test('reads the installed package version', async () => {
  expect(await readPackageVersion()).toBe(packageJson.version);
});

test.each([{}, { version: '' }, { version: null }, { version: 123 }])(
  'rejects a package manifest without a valid version: %j',
  async (content) => {
    const manifest = Bun.file(new URL('../package.json', import.meta.url));
    spyOn(manifest, 'json').mockResolvedValue(content);
    spyOn(Bun, 'file').mockReturnValue(manifest);
    expect(await captureRejection(readPackageVersion())).toMatchObject({
      message: expect.stringContaining('package.json has no valid version'),
    });
  },
);

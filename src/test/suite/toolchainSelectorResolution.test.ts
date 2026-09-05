import * as assert from 'assert';
import {
  resolveToolchainSelector,
  resolveProfileRecordForPath,
  toolchainSelectorArgs,
  toolchainSelectorLogLine,
  ToolchainSelectorFsProbe,
  ToolchainSelectorInputs
} from '../../language/toolchainSelectorResolution';

// F365 defect 2: the VS Code extension has no occurrence of the
// toolchain-selector vocabulary anywhere, so every language-server session
// it launches is silently Undeclared. These tests cover both the case
// where a profile record is discoverable (a --toolchain-selector argument
// must be produced) and the case where it genuinely is not (the absence
// must be explicit, carrying a reason, rather than silent).

const CUSTOM = 'custom';

function fakeFs(files: Record<string, string>): ToolchainSelectorFsProbe {
  return {
    fileExists: p => Object.prototype.hasOwnProperty.call(files, p),
    readFile: p => files[p]
  };
}

function baseInputs(overrides: Partial<ToolchainSelectorInputs>): ToolchainSelectorInputs {
  return {
    dafnyServerOverride: undefined,
    cliPathSetting: undefined,
    versionSetting: 'latest stable release',
    customVersionSentinel: CUSTOM,
    ...overrides
  };
}

suite('toolchainSelectorResolution', () => {

  suite('resolveProfileRecordForPath', () => {
    test('finds a profile record sitting directly beside the executable', () => {
      const fs = fakeFs({
        '/Users/josh/.local/lib/dafny/profiles/prod/current/profile.json': '{}'
      });
      const found = resolveProfileRecordForPath('/Users/josh/.local/lib/dafny/profiles/prod/current/dafny', fs);
      assert.deepStrictEqual(found, {
        profileRecordPath: '/Users/josh/.local/lib/dafny/profiles/prod/current/profile.json',
        source: 'sibling of /Users/josh/.local/lib/dafny/profiles/prod/current/dafny'
      });
    });

    test('follows a launcher shim to its exec target\'s sibling profile record', () => {
      const fs = fakeFs({
        '/Users/josh/.local/bin/dafny-prod': '#!/bin/sh\nexec /Users/josh/.local/lib/dafny/profiles/prod/current/dafny "$@"\n',
        '/Users/josh/.local/lib/dafny/profiles/prod/current/profile.json': '{}'
      });
      const found = resolveProfileRecordForPath('/Users/josh/.local/bin/dafny-prod', fs);
      assert.deepStrictEqual(found, {
        profileRecordPath: '/Users/josh/.local/lib/dafny/profiles/prod/current/profile.json',
        source: 'launcher /Users/josh/.local/bin/dafny-prod -> /Users/josh/.local/lib/dafny/profiles/prod/current/dafny'
      });
    });

    test('returns undefined when nothing is beside the path and it is not a launcher', () => {
      const fs = fakeFs({});
      assert.strictEqual(resolveProfileRecordForPath('/opt/homebrew/Cellar/dafny/4.11.0/bin/dafny', fs), undefined);
    });

    test('returns undefined for a launcher whose own exec target has no profile record', () => {
      const fs = fakeFs({
        '/Users/josh/.local/bin/dafny-prod': '#!/bin/sh\nexec /opt/homebrew/bin/dafny "$@"\n'
      });
      assert.strictEqual(resolveProfileRecordForPath('/Users/josh/.local/bin/dafny-prod', fs), undefined);
    });
  });

  suite('resolveToolchainSelector', () => {
    test('DAFNY_SERVER_OVERRIDE resolved via a profile record beside it is declared', () => {
      const fs = fakeFs({
        '/Users/josh/.local/lib/dafny/profiles/dev/current/profile.json': '{}'
      });
      const resolution = resolveToolchainSelector(
        baseInputs({ dafnyServerOverride: '/Users/josh/.local/lib/dafny/profiles/dev/current/dafny' }),
        fs
      );
      assert.strictEqual(resolution.kind, 'declared');
      if(resolution.kind === 'declared') {
        assert.strictEqual(resolution.profileRecordPath, '/Users/josh/.local/lib/dafny/profiles/dev/current/profile.json');
        assert.match(resolution.source, /DAFNY_SERVER_OVERRIDE/);
      }
    });

    test('DAFNY_SERVER_OVERRIDE resolved via a known launcher is declared', () => {
      const fs = fakeFs({
        '/Users/josh/.local/bin/dafny-prod': '#!/bin/sh\nexec /Users/josh/.local/lib/dafny/profiles/prod/current/dafny "$@"\n',
        '/Users/josh/.local/lib/dafny/profiles/prod/current/profile.json': '{}'
      });
      const resolution = resolveToolchainSelector(
        baseInputs({ dafnyServerOverride: '/Users/josh/.local/bin/dafny-prod' }),
        fs
      );
      assert.strictEqual(resolution.kind, 'declared');
      if(resolution.kind === 'declared') {
        assert.strictEqual(resolution.profileRecordPath, '/Users/josh/.local/lib/dafny/profiles/prod/current/profile.json');
      }
    });

    test('dafny.cliPath with dafny.version=custom, with a profile record beside it, is declared', () => {
      const fs = fakeFs({
        '/Users/josh/.local/lib/dafny/profiles/prod/current/profile.json': '{}'
      });
      const resolution = resolveToolchainSelector(
        baseInputs({
          cliPathSetting: '/Users/josh/.local/lib/dafny/profiles/prod/current/dafny',
          versionSetting: CUSTOM
        }),
        fs
      );
      assert.strictEqual(resolution.kind, 'declared');
      if(resolution.kind === 'declared') {
        assert.strictEqual(resolution.profileRecordPath, '/Users/josh/.local/lib/dafny/profiles/prod/current/profile.json');
        assert.match(resolution.source, /dafny\.cliPath/);
      }
    });

    test('DAFNY_SERVER_OVERRIDE with no discoverable record is explicitly undeclared, not silent', () => {
      const resolution = resolveToolchainSelector(
        baseInputs({ dafnyServerOverride: '/opt/homebrew/Cellar/dafny/4.11.0/bin/dafny' }),
        fakeFs({})
      );
      assert.strictEqual(resolution.kind, 'undeclared');
      if(resolution.kind === 'undeclared') {
        assert.match(resolution.reason, /DAFNY_SERVER_OVERRIDE/);
        assert.match(resolution.reason, /no discoverable/);
      }
    });

    test('dafny.cliPath set but dafny.version is not "custom" does not attempt cliPath resolution and is undeclared', () => {
      const fs = fakeFs({
        '/Users/josh/.local/lib/dafny/profiles/prod/current/profile.json': '{}'
      });
      const resolution = resolveToolchainSelector(
        baseInputs({
          cliPathSetting: '/Users/josh/.local/lib/dafny/profiles/prod/current/dafny',
          versionSetting: 'latest stable release'
        }),
        fs
      );
      assert.strictEqual(resolution.kind, 'undeclared');
      if(resolution.kind === 'undeclared') {
        assert.match(resolution.reason, /GitHubReleaseInstaller/);
      }
    });

    test('no cliPath/override configured (GitHub release / dafnyIdeVersion path) is explicitly undeclared', () => {
      const resolution = resolveToolchainSelector(baseInputs({ versionSetting: '4.11.0' }), fakeFs({}));
      assert.strictEqual(resolution.kind, 'undeclared');
      if(resolution.kind === 'undeclared') {
        assert.match(resolution.reason, /GitHubReleaseInstaller/);
        assert.match(resolution.reason, /neither of which is bound to any toolchain profile record/i);
      }
    });

    test('DAFNY_SERVER_OVERRIDE wins unconditionally over a resolvable dafny.cliPath', () => {
      const fs = fakeFs({
        '/Users/josh/.local/lib/dafny/profiles/dev/current/profile.json': '{}',
        '/Users/josh/.local/lib/dafny/profiles/prod/current/profile.json': '{}'
      });
      const resolution = resolveToolchainSelector(
        baseInputs({
          dafnyServerOverride: '/Users/josh/.local/lib/dafny/profiles/dev/current/dafny',
          cliPathSetting: '/Users/josh/.local/lib/dafny/profiles/prod/current/dafny',
          versionSetting: CUSTOM
        }),
        fs
      );
      assert.strictEqual(resolution.kind, 'declared');
      if(resolution.kind === 'declared') {
        assert.strictEqual(resolution.profileRecordPath, '/Users/josh/.local/lib/dafny/profiles/dev/current/profile.json');
      }
    });
  });

  suite('getLanguageServerLaunchArgsNew shape: toolchainSelectorArgs / toolchainSelectorLogLine', () => {
    test('a discoverable profile record appends --toolchain-selector to the launch args', () => {
      const fs = fakeFs({
        '/Users/josh/.local/lib/dafny/profiles/prod/current/profile.json': '{}'
      });
      const resolution = resolveToolchainSelector(
        baseInputs({
          cliPathSetting: '/Users/josh/.local/lib/dafny/profiles/prod/current/dafny',
          versionSetting: CUSTOM
        }),
        fs
      );
      const args = toolchainSelectorArgs(resolution);
      assert.deepStrictEqual(args, [
        '--toolchain-selector',
        '/Users/josh/.local/lib/dafny/profiles/prod/current/profile.json'
      ]);
      assert.match(toolchainSelectorLogLine(resolution), /declared/);
    });

    test('no discoverable profile record appends nothing, but the log line says so explicitly rather than being silent', () => {
      const resolution = resolveToolchainSelector(baseInputs({ versionSetting: '4.11.0' }), fakeFs({}));
      const args = toolchainSelectorArgs(resolution);
      assert.deepStrictEqual(args, []);
      const logLine = toolchainSelectorLogLine(resolution);
      assert.match(logLine, /UNDECLARED/);
      assert.match(logLine, /GitHubReleaseInstaller/);
    });
  });
});

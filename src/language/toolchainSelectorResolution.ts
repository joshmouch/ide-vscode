import * as fs from 'fs';
import * as path from 'path';

/**
 * Pure resolution of a `--toolchain-selector` argument for the language
 * server, from the same signals {@link CustomPathInstaller}/{@link
 * DafnyInstaller} already read to pick a Dafny binary. No VS Code import --
 * kept in its own module so it can be unit-tested directly under plain
 * Node/Mocha, matching the shape of `releaseAssetMatcher.ts`.
 *
 * Context (dafny-reboot-adversarial-findings F365, defect 2): the CLI/LSP
 * parity audit found that `ide-vscode/src/` had zero occurrences of the
 * toolchain-selector vocabulary anywhere, even though the language server
 * registers `ToolchainSelector.Option` (`--toolchain-selector`,
 * `Source/DafnyCore/Snapshot/ToolchainSelector.cs:123`) and keys every
 * compilation's identity on it. Four independent paths resolve a Dafny
 * binary without ever declaring a profile, so every language-server session
 * the extension launches was silently `Undeclared`. This module makes that
 * declaration where a profile record is actually discoverable, and makes
 * the absence explicit -- never silent -- where it is not.
 *
 * A `dafny-toolchain-profile/v2` record (see `ToolchainSelector.Read`) is a
 * `profile.json` file that a materializer writes beside the executable it
 * produced. Two shapes are recognized here, both read-only:
 *
 *  - The configured path already points *into* a profile's materialization
 *    (e.g. `~/.local/lib/dafny/profiles/prod/current/dafny`), so
 *    `profile.json` sits directly beside it.
 *  - The configured path is a launcher shim (e.g. `~/.local/bin/dafny-prod`)
 *    whose body is `exec <target> "$@"`; the profile record sits beside
 *    `<target>` instead. No profile name is ever hard-coded -- the launcher
 *    is followed wherever it points, per `ToolchainSelector.cs`'s own
 *    documentation of itself as "a transparent shim".
 */

/** Minimal filesystem access this module needs, so tests never touch a real disk. */
export interface ToolchainSelectorFsProbe {
  /** True if a regular file exists at this path. */
  fileExists(candidatePath: string): boolean;
  /** File contents as utf8 text, or undefined if it cannot be read as text. */
  readFile(candidatePath: string): string | undefined;
}

/** {@link ToolchainSelectorFsProbe} backed by the real filesystem. */
export const nodeFsProbe: ToolchainSelectorFsProbe = {
  fileExists(candidatePath: string): boolean {
    try {
      return fs.statSync(candidatePath).isFile();
    } catch(error: unknown) {
      return false;
    }
  },
  readFile(candidatePath: string): string | undefined {
    try {
      return fs.readFileSync(candidatePath, 'utf8');
    } catch(error: unknown) {
      return undefined;
    }
  }
};

export type ToolchainSelectorResolution =
  | { readonly kind: 'declared', readonly profileRecordPath: string, readonly source: string }
  | { readonly kind: 'undeclared', readonly reason: string };

export interface ToolchainSelectorInputs {
  /** `process.env['DAFNY_SERVER_OVERRIDE']`, resolved first and winning unconditionally, as CustomPathInstaller does. */
  readonly dafnyServerOverride: string | undefined;
  /** The effective `dafny.cliPath` setting, already resolved to an absolute path if configured. */
  readonly cliPathSetting: string | undefined;
  /** The effective `dafny.version` (or the undocumented `dafnyIdeVersion` env override), i.e. `getPreferredVersion()`. */
  readonly versionSetting: string;
  /** `LanguageServerConstants.Custom` -- `dafny.cliPath` only takes effect when this sentinel is selected. */
  readonly customVersionSentinel: string;
}

/**
 * Decide what this session's `--toolchain-selector` argument should be, or
 * declare plainly why none can be supplied. Mirrors the exact priority
 * `CustomPathInstaller.getCliPathUncached` uses to pick a binary, because a
 * selector that disagreed with which binary actually launches would be
 * worse than none.
 */
export function resolveToolchainSelector(
  inputs: ToolchainSelectorInputs,
  probe: ToolchainSelectorFsProbe
): ToolchainSelectorResolution {
  const { dafnyServerOverride, cliPathSetting, versionSetting, customVersionSentinel } = inputs;

  if(dafnyServerOverride !== undefined && dafnyServerOverride.length > 0) {
    const found = resolveProfileRecordForPath(dafnyServerOverride, probe);
    if(found) {
      return { kind: 'declared', profileRecordPath: found.profileRecordPath, source: `DAFNY_SERVER_OVERRIDE (${found.source})` };
    }
    return {
      kind: 'undeclared',
      reason: `DAFNY_SERVER_OVERRIDE=${dafnyServerOverride} names an executable with no discoverable `
        + 'dafny-toolchain-profile/v2 record beside it or beside its launcher target'
    };
  }

  if(cliPathSetting !== undefined && cliPathSetting.length > 0 && versionSetting === customVersionSentinel) {
    const found = resolveProfileRecordForPath(cliPathSetting, probe);
    if(found) {
      return { kind: 'declared', profileRecordPath: found.profileRecordPath, source: `dafny.cliPath (${found.source})` };
    }
    return {
      kind: 'undeclared',
      reason: `dafny.cliPath=${cliPathSetting} (dafny.version="${customVersionSentinel}") names an executable with `
        + 'no discoverable dafny-toolchain-profile/v2 record beside it or beside its launcher target'
    };
  }

  return {
    kind: 'undeclared',
    reason: 'no dafny.cliPath or DAFNY_SERVER_OVERRIDE is configured; the extension resolves its own binary '
      + `(dafny.version="${versionSetting}") via GitHubReleaseInstaller or FromSourceInstaller, neither of which `
      + 'is bound to any toolchain profile record'
  };
}

/**
 * Look for a `profile.json` describing `candidatePath`, either sitting
 * beside it directly or beside the executable a launcher script at
 * `candidatePath` `exec`s to.
 */
export function resolveProfileRecordForPath(
  candidatePath: string,
  probe: ToolchainSelectorFsProbe
): { profileRecordPath: string, source: string } | undefined {
  const direct = siblingProfileRecord(candidatePath, probe);
  if(direct !== undefined) {
    return { profileRecordPath: direct, source: `sibling of ${candidatePath}` };
  }

  const launcherTarget = readLauncherExecTarget(candidatePath, probe);
  if(launcherTarget !== undefined) {
    const viaLauncher = siblingProfileRecord(launcherTarget, probe);
    if(viaLauncher !== undefined) {
      return { profileRecordPath: viaLauncher, source: `launcher ${candidatePath} -> ${launcherTarget}` };
    }
  }

  return undefined;
}

/**
 * The literal CLI tokens {@link resolution} contributes to the language
 * server's launch arguments -- `['--toolchain-selector', <profile-record>]`
 * when declared (matching the `--toolchain-selector <path>` shape the
 * server itself parses, see `KeyedOperationOptionReachabilityTest.cs`), or
 * nothing when undeclared. Split out as its own pure function so the
 * launch-args assertion in tests reads directly off it rather than off a
 * re-implementation.
 */
export function toolchainSelectorArgs(resolution: ToolchainSelectorResolution): string[] {
  return resolution.kind === 'declared' ? [ '--toolchain-selector', resolution.profileRecordPath ] : [];
}

/**
 * The one line every resolution logs, so a session that cannot declare its
 * toolchain says so out loud instead of looking identical to a declared
 * one -- the defect's actual shape, per F365 defect 2.
 */
export function toolchainSelectorLogLine(resolution: ToolchainSelectorResolution): string {
  return resolution.kind === 'declared'
    ? `Toolchain selector: declared via ${resolution.source} (${resolution.profileRecordPath})`
    : `Toolchain selector: UNDECLARED -- ${resolution.reason}`;
}

function siblingProfileRecord(executablePath: string, probe: ToolchainSelectorFsProbe): string | undefined {
  const candidate = path.join(path.dirname(executablePath), 'profile.json');
  return probe.fileExists(candidate) ? candidate : undefined;
}

/**
 * If `scriptPath` is a shell shim of the `exec <target> "$@"` shape that
 * `dafny-prod`/`dafny-dev` use, return `<target>`. No profile name is
 * assumed -- only the shim's own declared exec target is trusted.
 */
function readLauncherExecTarget(scriptPath: string, probe: ToolchainSelectorFsProbe): string | undefined {
  const text = probe.readFile(scriptPath);
  if(text === undefined) {
    return undefined;
  }
  const match = /(?:^|\n)\s*exec\s+"?([^"\s]+)"?/.exec(text);
  return match ? match[1] : undefined;
}

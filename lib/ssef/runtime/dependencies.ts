import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getSSEFConfig } from "../config";
import type {
  SkillManifestV1,
  SkillRuntimeDependencies,
} from "../contracts/manifest";

const DEPENDENCY_MARKER_FILE = ".ssef_runtime_dependencies.json";
const MAX_COMMAND_OUTPUT_CHARS = 24_000;
const MAX_LOG_ENTRIES = 80;

export type SSEFSkillRuntimeDependencyMode =
  | "forge_sandbox"
  | "activation"
  | "runtime";

export type SSEFSkillRuntimeDependencySpec = {
  npm: string[];
  pip: string[];
};

export type SSEFSkillRuntimeDependencyInstallStatus =
  | "ok"
  | "skipped"
  | "failed";

export type SSEFSkillRuntimeDependencyInstallResult = {
  status: SSEFSkillRuntimeDependencyInstallStatus;
  mode: SSEFSkillRuntimeDependencyMode;
  attempted: boolean;
  message: string;
  manifestDependencyHash: string;
  markerPath: string | null;
  dependencies: SSEFSkillRuntimeDependencySpec;
  runtimeEnv: Record<string, string>;
  npmInstalled: boolean;
  pipInstalled: boolean;
  pythonBin: string | null;
  logs: string[];
  error: string | null;
};

type EnsureDependenciesInput = {
  versionRoot: string;
  manifest: SkillManifestV1;
  mode: SSEFSkillRuntimeDependencyMode;
  allowInstall?: boolean;
  timeoutMs?: number;
};

type DependencyMarker = {
  schema_version: 1;
  manifest_dependency_hash: string;
  installed_at: string;
  npm: string[];
  pip: string[];
  npm_installed: boolean;
  pip_installed: boolean;
  python_bin: string | null;
  status: "ok" | "failed";
  error: string | null;
};

type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  commandText: string;
};

function appendLog(logs: string[], line: string) {
  if (logs.length >= MAX_LOG_ENTRIES) {
    return;
  }
  logs.push(line);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyText(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function truncateText(value: string, maxChars = 800) {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function uniqueList(values: string[]) {
  return Array.from(new Set(values.map((entry) => entry.trim()).filter(Boolean)));
}

function normalizeRuntimeDependencyList(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as string[];
  }
  return uniqueList(
    value
      .map((entry) => (typeof entry === "string" ? entry : ""))
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

export function resolveSSEFSkillRuntimeDependencies(
  manifest: SkillManifestV1
): SSEFSkillRuntimeDependencySpec {
  const source = manifest.runtime_dependencies;
  if (!source) {
    return {
      npm: [],
      pip: [],
    };
  }

  const normalizedSource: SkillRuntimeDependencies = isRecord(source)
    ? source
    : {};
  return {
    npm: normalizeRuntimeDependencyList(normalizedSource.npm),
    pip: normalizeRuntimeDependencyList(normalizedSource.pip),
  };
}

function buildDependencyHash(spec: SSEFSkillRuntimeDependencySpec) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        npm: [...spec.npm].sort(),
        pip: [...spec.pip].sort(),
      })
    )
    .digest("hex");
}

async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function getVenvBinDir(versionRoot: string) {
  return path.join(versionRoot, ".venv", process.platform === "win32" ? "Scripts" : "bin");
}

function getVenvPythonPath(versionRoot: string) {
  return path.join(
    getVenvBinDir(versionRoot),
    process.platform === "win32" ? "python.exe" : "python"
  );
}

function getVenvPipPath(versionRoot: string) {
  return path.join(
    getVenvBinDir(versionRoot),
    process.platform === "win32" ? "pip.exe" : "pip"
  );
}

async function buildRuntimeEnvPatch(
  versionRoot: string,
  spec: SSEFSkillRuntimeDependencySpec
) {
  if (spec.pip.length === 0) {
    return {} as Record<string, string>;
  }

  const pythonBin = getVenvPythonPath(versionRoot);
  const venvBin = getVenvBinDir(versionRoot);
  if (!(await pathExists(pythonBin))) {
    return {} as Record<string, string>;
  }

  const mergedPath = process.env.PATH
    ? `${venvBin}${path.delimiter}${process.env.PATH}`
    : venvBin;
  return {
    PATH: mergedPath,
    SSEF_PYTHON_BIN: pythonBin,
  };
}

async function runCommand(params: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<CommandResult> {
  const commandText = [params.command, ...params.args].join(" ");
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: params.env ?? process.env,
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const appendChunk = (chunk: Buffer | string, target: "stdout" | "stderr") => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (!text) {
        return;
      }
      const consumed = stdout.length + stderr.length;
      const remaining = MAX_COMMAND_OUTPUT_CHARS - consumed;
      if (remaining <= 0) {
        return;
      }
      const clipped = text.length > remaining ? text.slice(0, remaining) : text;
      if (target === "stdout") {
        stdout += clipped;
      } else {
        stderr += clipped;
      }
    };

    child.stdout.on("data", (chunk: Buffer) => appendChunk(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => appendChunk(chunk, "stderr"));

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, params.timeoutMs);

    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && exitCode === 0,
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
        commandText,
      });
    });
  });
}

async function writeJsonFile(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readDependencyMarker(markerPath: string) {
  if (!(await pathExists(markerPath))) {
    return null;
  }
  try {
    const raw = await fs.readFile(markerPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const marker: DependencyMarker = {
      schema_version: 1,
      manifest_dependency_hash: asNonEmptyText(parsed.manifest_dependency_hash),
      installed_at: asNonEmptyText(parsed.installed_at),
      npm: normalizeRuntimeDependencyList(parsed.npm),
      pip: normalizeRuntimeDependencyList(parsed.pip),
      npm_installed: Boolean(parsed.npm_installed),
      pip_installed: Boolean(parsed.pip_installed),
      python_bin: asNonEmptyText(parsed.python_bin) || null,
      status: parsed.status === "failed" ? "failed" : "ok",
      error: asNonEmptyText(parsed.error) || null,
    };
    if (!marker.manifest_dependency_hash) {
      return null;
    }
    return marker;
  } catch {
    return null;
  }
}

async function writeDependencyMarker(
  markerPath: string,
  marker: DependencyMarker
) {
  await writeJsonFile(markerPath, marker);
}

function buildFailedResult(params: {
  mode: SSEFSkillRuntimeDependencyMode;
  attempted: boolean;
  message: string;
  error: string | null;
  manifestDependencyHash: string;
  markerPath: string;
  dependencies: SSEFSkillRuntimeDependencySpec;
  logs: string[];
}) {
  return {
    status: "failed" as const,
    mode: params.mode,
    attempted: params.attempted,
    message: params.message,
    manifestDependencyHash: params.manifestDependencyHash,
    markerPath: params.markerPath,
    dependencies: params.dependencies,
    runtimeEnv: {},
    npmInstalled: false,
    pipInstalled: false,
    pythonBin: null,
    logs: params.logs,
    error: params.error,
  };
}

async function assertDependencyArtifactsPresent(
  versionRoot: string,
  spec: SSEFSkillRuntimeDependencySpec
) {
  if (spec.npm.length > 0) {
    const nodeModulesPath = path.join(versionRoot, "node_modules");
    if (!(await pathExists(nodeModulesPath))) {
      return false;
    }
  }
  if (spec.pip.length > 0) {
    const pythonPath = getVenvPythonPath(versionRoot);
    if (!(await pathExists(pythonPath))) {
      return false;
    }
  }
  return true;
}

async function ensurePackageJson(versionRoot: string, manifest: SkillManifestV1) {
  const packageJsonPath = path.join(versionRoot, "package.json");
  if (await pathExists(packageJsonPath)) {
    return packageJsonPath;
  }
  const packageJson = {
    name: `ssef-${manifest.id}`.replace(/[^a-z0-9._-]+/gi, "-").toLowerCase(),
    private: true,
    version: manifest.version,
    description: manifest.description,
    license: "UNLICENSED",
  };
  await writeJsonFile(packageJsonPath, packageJson);
  return packageJsonPath;
}

function resolvePythonBootstrapCandidates() {
  const envPython = asNonEmptyText(process.env.SSEF_PYTHON_BIN);
  return uniqueList([envPython, "python3", "python"]);
}

async function ensurePythonVenv(params: {
  versionRoot: string;
  timeoutMs: number;
  logs: string[];
}) {
  const pythonPath = getVenvPythonPath(params.versionRoot);
  const pipPath = getVenvPipPath(params.versionRoot);
  if ((await pathExists(pythonPath)) && (await pathExists(pipPath))) {
    return {
      pythonBin: pythonPath,
      pipBin: pipPath,
    };
  }

  const candidates = resolvePythonBootstrapCandidates();
  let lastError = "Python runtime is unavailable.";
  for (const candidate of candidates) {
    try {
      const result = await runCommand({
        command: candidate,
        args: ["-m", "venv", ".venv"],
        cwd: params.versionRoot,
        timeoutMs: params.timeoutMs,
      });
      appendLog(params.logs, `[python-venv] ${result.commandText}`);
      if (result.ok) {
        if ((await pathExists(pythonPath)) && (await pathExists(pipPath))) {
          return {
            pythonBin: pythonPath,
            pipBin: pipPath,
          };
        }
        lastError = "python venv command succeeded but .venv binaries were not created.";
        continue;
      }
      lastError =
        truncateText(result.stderr || result.stdout, 600) ||
        `python venv exited with code ${String(result.exitCode)}.`;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        lastError = `Command not found: ${candidate}`;
        continue;
      }
      lastError =
        error instanceof Error
          ? error.message
          : "python venv setup failed unexpectedly.";
    }
  }

  throw new Error(lastError);
}

async function installNpmDependencies(params: {
  versionRoot: string;
  dependencies: string[];
  timeoutMs: number;
  logs: string[];
}) {
  if (params.dependencies.length === 0) {
    return;
  }
  const result = await runCommand({
    command: "npm",
    args: [
      "install",
      "--no-audit",
      "--no-fund",
      "--omit=dev",
      "--no-package-lock",
      ...params.dependencies,
    ],
    cwd: params.versionRoot,
    timeoutMs: params.timeoutMs,
  });

  appendLog(params.logs, `[npm] ${result.commandText}`);
  if (result.stdout.trim()) {
    appendLog(params.logs, `[npm:stdout] ${truncateText(result.stdout, 600)}`);
  }
  if (result.stderr.trim()) {
    appendLog(params.logs, `[npm:stderr] ${truncateText(result.stderr, 600)}`);
  }
  if (!result.ok) {
    const detail =
      truncateText(result.stderr || result.stdout, 600) ||
      `npm install exited with code ${String(result.exitCode)}.`;
    throw new Error(detail);
  }
}

async function installPipDependencies(params: {
  versionRoot: string;
  dependencies: string[];
  timeoutMs: number;
  logs: string[];
}) {
  if (params.dependencies.length === 0) {
    return {
      pythonBin: null as string | null,
    };
  }

  const venv = await ensurePythonVenv({
    versionRoot: params.versionRoot,
    timeoutMs: params.timeoutMs,
    logs: params.logs,
  });
  const venvBin = getVenvBinDir(params.versionRoot);
  const installEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: process.env.PATH
      ? `${venvBin}${path.delimiter}${process.env.PATH}`
      : venvBin,
    SSEF_PYTHON_BIN: venv.pythonBin,
  };

  const result = await runCommand({
    command: venv.pipBin,
    args: [
      "install",
      "--disable-pip-version-check",
      "--no-input",
      ...params.dependencies,
    ],
    cwd: params.versionRoot,
    timeoutMs: params.timeoutMs,
    env: installEnv,
  });
  appendLog(params.logs, `[pip] ${result.commandText}`);
  if (result.stdout.trim()) {
    appendLog(params.logs, `[pip:stdout] ${truncateText(result.stdout, 600)}`);
  }
  if (result.stderr.trim()) {
    appendLog(params.logs, `[pip:stderr] ${truncateText(result.stderr, 600)}`);
  }
  if (!result.ok) {
    const detail =
      truncateText(result.stderr || result.stdout, 600) ||
      `pip install exited with code ${String(result.exitCode)}.`;
    throw new Error(detail);
  }
  return {
    pythonBin: venv.pythonBin,
  };
}

export async function ensureSSEFSkillRuntimeDependencies(
  input: EnsureDependenciesInput
): Promise<SSEFSkillRuntimeDependencyInstallResult> {
  const config = getSSEFConfig();
  const timeoutMs =
    Number.isFinite(input.timeoutMs) && input.timeoutMs && input.timeoutMs > 0
      ? Math.floor(input.timeoutMs)
      : config.dependencyManagement.installTimeoutMs;

  const spec = resolveSSEFSkillRuntimeDependencies(input.manifest);
  const markerPath = path.join(input.versionRoot, DEPENDENCY_MARKER_FILE);
  const manifestDependencyHash = buildDependencyHash(spec);
  const logs: string[] = [];

  if (spec.npm.length === 0 && spec.pip.length === 0) {
    return {
      status: "skipped",
      mode: input.mode,
      attempted: false,
      message: "No runtime dependencies declared in manifest.",
      manifestDependencyHash,
      markerPath: null,
      dependencies: spec,
      runtimeEnv: {},
      npmInstalled: false,
      pipInstalled: false,
      pythonBin: null,
      logs,
      error: null,
    };
  }

  await fs.mkdir(input.versionRoot, { recursive: true });
  const marker = await readDependencyMarker(markerPath);
  const artifactsPresent = await assertDependencyArtifactsPresent(input.versionRoot, spec);
  if (
    marker &&
    marker.status === "ok" &&
    marker.manifest_dependency_hash === manifestDependencyHash &&
    artifactsPresent
  ) {
    const runtimeEnv = await buildRuntimeEnvPatch(input.versionRoot, spec);
    return {
      status: "skipped",
      mode: input.mode,
      attempted: false,
      message: "Runtime dependencies already provisioned.",
      manifestDependencyHash,
      markerPath,
      dependencies: spec,
      runtimeEnv,
      npmInstalled: marker.npm_installed,
      pipInstalled: marker.pip_installed,
      pythonBin: marker.python_bin,
      logs,
      error: null,
    };
  }

  const allowInstall = input.allowInstall !== false;
  if (!allowInstall) {
    return buildFailedResult({
      mode: input.mode,
      attempted: false,
      message: "Runtime dependencies are missing and automatic install is disabled.",
      error: "dependency_auto_install_disabled",
      manifestDependencyHash,
      markerPath,
      dependencies: spec,
      logs,
    });
  }

  let npmInstalled = false;
  let pipInstalled = false;
  let pythonBin: string | null = null;

  try {
    if (spec.npm.length > 0) {
      await ensurePackageJson(input.versionRoot, input.manifest);
      await installNpmDependencies({
        versionRoot: input.versionRoot,
        dependencies: spec.npm,
        timeoutMs,
        logs,
      });
      npmInstalled = true;
    }
    if (spec.pip.length > 0) {
      const pipResult = await installPipDependencies({
        versionRoot: input.versionRoot,
        dependencies: spec.pip,
        timeoutMs,
        logs,
      });
      pipInstalled = true;
      pythonBin = pipResult.pythonBin;
    }

    await writeDependencyMarker(markerPath, {
      schema_version: 1,
      manifest_dependency_hash: manifestDependencyHash,
      installed_at: new Date().toISOString(),
      npm: spec.npm,
      pip: spec.pip,
      npm_installed: npmInstalled,
      pip_installed: pipInstalled,
      python_bin: pythonBin,
      status: "ok",
      error: null,
    });

    const runtimeEnv = await buildRuntimeEnvPatch(input.versionRoot, spec);
    return {
      status: "ok",
      mode: input.mode,
      attempted: true,
      message: "Runtime dependencies installed successfully.",
      manifestDependencyHash,
      markerPath,
      dependencies: spec,
      runtimeEnv,
      npmInstalled,
      pipInstalled,
      pythonBin: pythonBin ?? (runtimeEnv.SSEF_PYTHON_BIN ?? null),
      logs,
      error: null,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Runtime dependency installation failed.";
    appendLog(logs, `[error] ${message}`);
    await writeDependencyMarker(markerPath, {
      schema_version: 1,
      manifest_dependency_hash: manifestDependencyHash,
      installed_at: new Date().toISOString(),
      npm: spec.npm,
      pip: spec.pip,
      npm_installed: npmInstalled,
      pip_installed: pipInstalled,
      python_bin: pythonBin,
      status: "failed",
      error: message,
    });
    return buildFailedResult({
      mode: input.mode,
      attempted: true,
      message: "Runtime dependency installation failed.",
      error: message,
      manifestDependencyHash,
      markerPath,
      dependencies: spec,
      logs,
    });
  }
}

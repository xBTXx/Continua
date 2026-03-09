import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureSSEFReady } from "@/lib/ssef/bootstrap";
import type { SSEFConfig } from "@/lib/ssef/config";
import { getSSEFConfig } from "@/lib/ssef/config";

const SKILLS_INDEX_VERSION = 1;
const INTEGRITY_HASHES_VERSION = 1;
const SKILLS_INDEX_ASSET_KEY = "skills_index";

export type SkillsIndexFileV1 = {
  version: 1;
  skills: Array<Record<string, unknown>>;
};

export type ProtectedAssetEntry = {
  relative_path: string;
  sha256: string;
  updated_at: string;
  updated_by: string;
};

type IntegrityHashesPayloadV1 = {
  version: 1;
  generated_at: string;
  assets: Record<string, ProtectedAssetEntry>;
};

export type IntegrityHashesFileV1 = IntegrityHashesPayloadV1 & {
  self_hash: string;
};

export type ProtectedAssetPaths = {
  rootDir: string;
  registryDir: string;
  skillsIndexPath: string;
  integrityHashesPath: string;
};

export type ProtectedAssetPolicy = {
  writeAllowedPaths: string[];
  skillsIndexPath: string;
  integrityHashesPath: string;
};

export type ProtectedAssetsStatus = {
  enabled: boolean;
  ready: boolean;
  verifiedAt: string;
  paths: ProtectedAssetPaths;
};

export type ProtectedSkillsIndexWriteOptions = {
  actor?: string;
  allowUnsafeOverwrite?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeActor(value: string | undefined) {
  const actor = value?.trim();
  return actor && actor.length > 0 ? actor : "ssef-core";
}

function toPosixPath(value: string) {
  return value.split(path.sep).join("/");
}

function toRelativePath(root: string, target: string) {
  return toPosixPath(path.relative(root, target));
}

function stableSortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableSortValue(entry));
  }
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    Object.keys(value)
      .sort()
      .forEach((key) => {
        sorted[key] = stableSortValue(value[key]);
      });
    return sorted;
  }
  return value;
}

function stableStringify(value: unknown) {
  return JSON.stringify(stableSortValue(value));
}

function sha256Text(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath: string) {
  const content = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeFileAtomic(filePath: string, content: string) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `.tmp-${path.basename(filePath)}-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`
  );
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, filePath);
}

function asIsoTimestamp(value: unknown, label: string) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a timestamp string.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} must be a valid ISO timestamp.`);
  }
  return parsed.toISOString();
}

function normalizeSkillsIndexFile(value: unknown): SkillsIndexFileV1 {
  if (!isRecord(value)) {
    throw new Error("skills_index.json must be an object.");
  }
  const version = Number(value.version);
  if (!Number.isInteger(version) || version !== SKILLS_INDEX_VERSION) {
    throw new Error(`skills_index.json version must equal ${SKILLS_INDEX_VERSION}.`);
  }
  if (!Array.isArray(value.skills)) {
    throw new Error("skills_index.json.skills must be an array.");
  }
  const skills = value.skills.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`skills_index.json.skills[${index}] must be an object.`);
    }
    return entry;
  });
  return {
    version: SKILLS_INDEX_VERSION,
    skills,
  };
}

function normalizeIntegrityAssetEntry(
  value: unknown,
  label: string
): ProtectedAssetEntry {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const relativePath = value.relative_path;
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new Error(`${label}.relative_path must be a non-empty string.`);
  }
  const sha256 = value.sha256;
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error(`${label}.sha256 must be a 64-char hex digest.`);
  }
  const updatedBy = value.updated_by;
  if (typeof updatedBy !== "string" || !updatedBy.trim()) {
    throw new Error(`${label}.updated_by must be a non-empty string.`);
  }
  return {
    relative_path: relativePath,
    sha256: sha256.toLowerCase(),
    updated_at: asIsoTimestamp(value.updated_at, `${label}.updated_at`),
    updated_by: updatedBy.trim(),
  };
}

function normalizeIntegrityHashesFile(value: unknown): IntegrityHashesFileV1 {
  if (!isRecord(value)) {
    throw new Error("integrity_hashes.json must be an object.");
  }
  const version = Number(value.version);
  if (!Number.isInteger(version) || version !== INTEGRITY_HASHES_VERSION) {
    throw new Error(
      `integrity_hashes.json version must equal ${INTEGRITY_HASHES_VERSION}.`
    );
  }
  if (typeof value.self_hash !== "string" || !/^[a-f0-9]{64}$/i.test(value.self_hash)) {
    throw new Error("integrity_hashes.json self_hash must be a 64-char hex digest.");
  }
  if (!isRecord(value.assets)) {
    throw new Error("integrity_hashes.json.assets must be an object.");
  }
  const assets: Record<string, ProtectedAssetEntry> = {};
  for (const [assetKey, assetValue] of Object.entries(value.assets)) {
    assets[assetKey] = normalizeIntegrityAssetEntry(
      assetValue,
      `integrity_hashes.json.assets.${assetKey}`
    );
  }
  return {
    version: INTEGRITY_HASHES_VERSION,
    generated_at: asIsoTimestamp(value.generated_at, "generated_at"),
    assets,
    self_hash: value.self_hash.toLowerCase(),
  };
}

function buildIntegrityHashesFile(
  assets: Record<string, ProtectedAssetEntry>,
  generatedAt = new Date().toISOString()
): IntegrityHashesFileV1 {
  const payload: IntegrityHashesPayloadV1 = {
    version: INTEGRITY_HASHES_VERSION,
    generated_at: generatedAt,
    assets,
  };
  return {
    ...payload,
    self_hash: sha256Text(stableStringify(payload)),
  };
}

function assertIntegrityFileSelfHash(file: IntegrityHashesFileV1) {
  const payload: IntegrityHashesPayloadV1 = {
    version: file.version,
    generated_at: file.generated_at,
    assets: file.assets,
  };
  const expected = sha256Text(stableStringify(payload));
  if (expected !== file.self_hash) {
    throw new Error(
      "integrity_hashes.json failed self-hash verification (possible external mutation)."
    );
  }
}

async function readJsonFile(filePath: string) {
  const raw = await fs.readFile(filePath, "utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Invalid JSON in ${filePath}.`);
  }
}

async function writeJsonFile(filePath: string, value: unknown) {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function emptySkillsIndex(): SkillsIndexFileV1 {
  return {
    version: SKILLS_INDEX_VERSION,
    skills: [],
  };
}

function getPathsFromConfig(config: SSEFConfig): ProtectedAssetPaths {
  return {
    rootDir: config.rootDir,
    registryDir: config.registryDir,
    skillsIndexPath: config.skillsIndexPath,
    integrityHashesPath: config.integrityHashesPath,
  };
}

async function ensureSkillsIndexFile(paths: ProtectedAssetPaths) {
  if (await pathExists(paths.skillsIndexPath)) {
    return false;
  }
  await fs.mkdir(paths.registryDir, { recursive: true });
  try {
    await fs.writeFile(
      paths.skillsIndexPath,
      `${JSON.stringify(emptySkillsIndex(), null, 2)}\n`,
      { encoding: "utf8", flag: "wx" }
    );
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

async function ensureIntegrityHashesFile(
  paths: ProtectedAssetPaths,
  actor: string
) {
  if (await pathExists(paths.integrityHashesPath)) {
    return false;
  }

  await fs.mkdir(paths.registryDir, { recursive: true });
  const skillsIndexHash = await sha256File(paths.skillsIndexPath);
  const createdAt = new Date().toISOString();
  const integrityFile = buildIntegrityHashesFile({
    [SKILLS_INDEX_ASSET_KEY]: {
      relative_path: toRelativePath(paths.rootDir, paths.skillsIndexPath),
      sha256: skillsIndexHash,
      updated_at: createdAt,
      updated_by: actor,
    },
  });
  try {
    await fs.writeFile(
      paths.integrityHashesPath,
      `${JSON.stringify(integrityFile, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" }
    );
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

async function loadIntegrityHashesFile(paths: ProtectedAssetPaths) {
  const parsed = await readJsonFile(paths.integrityHashesPath);
  const file = normalizeIntegrityHashesFile(parsed);
  assertIntegrityFileSelfHash(file);
  return file;
}

function buildSkillsIndexAssetEntry(
  paths: ProtectedAssetPaths,
  sha256: string,
  actor: string,
  updatedAt = new Date().toISOString()
): ProtectedAssetEntry {
  return {
    relative_path: toRelativePath(paths.rootDir, paths.skillsIndexPath),
    sha256,
    updated_at: updatedAt,
    updated_by: actor,
  };
}

function assertSkillsIndexNotMutated(
  expectedHash: string | undefined,
  actualHash: string,
  allowUnsafeOverwrite: boolean
) {
  if (!expectedHash) {
    return;
  }
  if (expectedHash === actualHash) {
    return;
  }
  if (allowUnsafeOverwrite) {
    return;
  }
  throw new Error(
    "skills_index.json changed outside protected SSEF writers. Refusing write."
  );
}

let protectedAssetWriteQueue: Promise<void> = Promise.resolve();

function enqueueProtectedWrite<T>(task: () => Promise<T>) {
  const run = protectedAssetWriteQueue.then(task, task);
  protectedAssetWriteQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function getProtectedAssetPaths(config = getSSEFConfig()): ProtectedAssetPaths {
  return getPathsFromConfig(config);
}

export function getProtectedAssetPolicy(
  config = getSSEFConfig()
): ProtectedAssetPolicy {
  const paths = getPathsFromConfig(config);
  return {
    writeAllowedPaths: [paths.skillsIndexPath, paths.integrityHashesPath],
    skillsIndexPath: paths.skillsIndexPath,
    integrityHashesPath: paths.integrityHashesPath,
  };
}

export async function ensureProtectedAssetsReady(): Promise<ProtectedAssetsStatus> {
  const bootstrap = await ensureSSEFReady();
  const paths = getPathsFromConfig(bootstrap.config);
  if (!bootstrap.enabled) {
    return {
      enabled: false,
      ready: false,
      verifiedAt: new Date().toISOString(),
      paths,
    };
  }

  await ensureSkillsIndexFile(paths);
  await ensureIntegrityHashesFile(paths, "ssef-bootstrap");

  const integrityFile = await loadIntegrityHashesFile(paths);
  const currentSkillsIndexHash = await sha256File(paths.skillsIndexPath);
  const expectedSkillsIndexHash =
    integrityFile.assets[SKILLS_INDEX_ASSET_KEY]?.sha256;

  if (!expectedSkillsIndexHash) {
    const actor = "ssef-bootstrap";
    integrityFile.assets[SKILLS_INDEX_ASSET_KEY] = buildSkillsIndexAssetEntry(
      paths,
      currentSkillsIndexHash,
      actor
    );
    await writeJsonFile(
      paths.integrityHashesPath,
      buildIntegrityHashesFile(integrityFile.assets)
    );
  } else if (expectedSkillsIndexHash !== currentSkillsIndexHash) {
    throw new Error(
      "skills_index.json hash mismatch with integrity record (possible external mutation)."
    );
  }

  return {
    enabled: true,
    ready: true,
    verifiedAt: new Date().toISOString(),
    paths,
  };
}

export async function readProtectedIntegrityHashes(): Promise<IntegrityHashesFileV1> {
  const status = await ensureProtectedAssetsReady();
  if (!status.enabled || !status.ready) {
    throw new Error("SSEF is disabled. Protected assets are unavailable.");
  }
  return loadIntegrityHashesFile(status.paths);
}

export async function readProtectedSkillsIndex(): Promise<SkillsIndexFileV1> {
  const status = await ensureProtectedAssetsReady();
  if (!status.enabled || !status.ready) {
    throw new Error("SSEF is disabled. Protected assets are unavailable.");
  }
  const parsed = await readJsonFile(status.paths.skillsIndexPath);
  return normalizeSkillsIndexFile(parsed);
}

export async function writeProtectedSkillsIndex(
  next: SkillsIndexFileV1,
  options: ProtectedSkillsIndexWriteOptions = {}
) {
  return enqueueProtectedWrite(() =>
    writeProtectedSkillsIndexInternal(next, options)
  );
}

export async function mutateProtectedSkillsIndex(
  mutator: (
    current: SkillsIndexFileV1
  ) => SkillsIndexFileV1 | Promise<SkillsIndexFileV1>,
  options: ProtectedSkillsIndexWriteOptions = {}
) {
  return enqueueProtectedWrite(async () => {
    const current = await readProtectedSkillsIndex();
    const next = await mutator(current);
    return writeProtectedSkillsIndexInternal(next, options);
  });
}

async function writeProtectedSkillsIndexInternal(
  next: SkillsIndexFileV1,
  options: ProtectedSkillsIndexWriteOptions = {}
) {
  const status = await ensureProtectedAssetsReady();
  if (!status.enabled || !status.ready) {
    throw new Error("SSEF is disabled. Cannot write protected assets.");
  }
  const actor = normalizeActor(options.actor);
  const validatedNext = normalizeSkillsIndexFile(next);
  const integrityFile = await loadIntegrityHashesFile(status.paths);
  const currentHash = await sha256File(status.paths.skillsIndexPath);
  const expectedHash = integrityFile.assets[SKILLS_INDEX_ASSET_KEY]?.sha256;

  assertSkillsIndexNotMutated(
    expectedHash,
    currentHash,
    options.allowUnsafeOverwrite === true
  );

  await writeJsonFile(status.paths.skillsIndexPath, validatedNext);
  const nextHash = await sha256File(status.paths.skillsIndexPath);
  integrityFile.assets[SKILLS_INDEX_ASSET_KEY] = buildSkillsIndexAssetEntry(
    status.paths,
    nextHash,
    actor
  );

  const nextIntegrityFile = buildIntegrityHashesFile(integrityFile.assets);
  await writeJsonFile(status.paths.integrityHashesPath, nextIntegrityFile);

  return {
    writtenAt: new Date().toISOString(),
    skillsIndexHash: nextHash,
    integrityHash: nextIntegrityFile.self_hash,
    actor,
  };
}

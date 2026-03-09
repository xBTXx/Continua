import fs from "node:fs/promises";
import type { SSEFConfig } from "./config";
import { getSSEFConfig } from "./config";

type SkillsIndexV1 = {
  version: 1;
  skills: Array<Record<string, unknown>>;
};

export type SSEFBootstrapResult = {
  enabled: boolean;
  ready: boolean;
  config: SSEFConfig;
  checkedAt: string;
  createdPaths: string[];
  indexInitialized: boolean;
};

let inFlightBootstrap: Promise<SSEFBootstrapResult> | null = null;

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectory(
  dirPath: string,
  createdPaths: string[]
): Promise<void> {
  if (await pathExists(dirPath)) {
    return;
  }
  await fs.mkdir(dirPath, { recursive: true });
  createdPaths.push(dirPath);
}

async function ensureSkillsIndexFile(
  filePath: string,
  createdPaths: string[]
): Promise<boolean> {
  if (await pathExists(filePath)) {
    return false;
  }

  const emptyIndex: SkillsIndexV1 = {
    version: 1,
    skills: [],
  };

  try {
    await fs.writeFile(filePath, `${JSON.stringify(emptyIndex, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    createdPaths.push(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

async function performBootstrap(config: SSEFConfig): Promise<SSEFBootstrapResult> {
  const createdPaths: string[] = [];

  await ensureDirectory(config.rootDir, createdPaths);
  await ensureDirectory(config.registryDir, createdPaths);
  await ensureDirectory(config.vaultDir, createdPaths);
  await ensureDirectory(config.forgeDir, createdPaths);
  await ensureDirectory(config.sandboxDir, createdPaths);

  const indexInitialized = await ensureSkillsIndexFile(
    config.skillsIndexPath,
    createdPaths
  );
  const ready = await pathExists(config.skillsIndexPath);

  return {
    enabled: true,
    ready,
    config,
    checkedAt: new Date().toISOString(),
    createdPaths,
    indexInitialized,
  };
}

export async function ensureSSEFReady(): Promise<SSEFBootstrapResult> {
  const config = getSSEFConfig();
  if (!config.enabled) {
    return {
      enabled: false,
      ready: false,
      config,
      checkedAt: new Date().toISOString(),
      createdPaths: [],
      indexInitialized: false,
    };
  }

  if (!inFlightBootstrap) {
    inFlightBootstrap = performBootstrap(config).finally(() => {
      inFlightBootstrap = null;
    });
  }

  return inFlightBootstrap;
}

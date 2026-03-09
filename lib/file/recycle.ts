import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import {
    resolveWorkspaceRoot,
    resolveWorkspacePath,
    toWorkspaceRelative,
    toWorkspaceRelativeInput,
    getRecycleDays,
    pathExists,
    toStringValue,
    parsePositiveInt
} from "./utils";
import { DEFAULT_LIST_LIMIT } from "./constants";

export async function ensureWorkspaceRoot() {
    const root = resolveWorkspaceRoot();
    await fs.promises.mkdir(root, { recursive: true });
    return root;
}

export async function ensureRecycleBin() {
    const root = await ensureWorkspaceRoot();
    const recycleRoot = path.join(root, ".recycle_bin");
    await fs.promises.mkdir(recycleRoot, { recursive: true });
    return recycleRoot;
}

export async function cleanupRecycleBin() {
    const recycleRoot = await ensureRecycleBin();
    const retentionMs = getRecycleDays() * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - retentionMs;
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(recycleRoot, { withFileTypes: true });
    } catch {
        return;
    }
    await Promise.all(
        entries
            .filter((entry) => entry.isDirectory())
            .map(async (entry) => {
                const entryPath = path.join(recycleRoot, entry.name);
                const metadataPath = path.join(entryPath, "metadata.json");
                try {
                    const raw = await fs.promises.readFile(metadataPath, "utf8");
                    const metadata = JSON.parse(raw) as { deleted_at?: string };
                    const deletedAt = metadata.deleted_at
                        ? Date.parse(metadata.deleted_at)
                        : NaN;
                    if (Number.isFinite(deletedAt) && deletedAt < cutoff) {
                        await fs.promises.rm(entryPath, { recursive: true, force: true });
                    }
                } catch {
                    return;
                }
            })
    );
}

export async function moveToRecycle(filePath: string) {
    const stats = await fs.promises.lstat(filePath);
    const isDirectory = stats.isDirectory();
    const recycleRoot = await ensureRecycleBin();
    const recycleId = crypto.randomUUID();
    const recycleEntry = path.join(recycleRoot, recycleId);
    await fs.promises.mkdir(recycleEntry, { recursive: true });
    const name = path.basename(filePath);
    const movedPath = path.join(recycleEntry, name);
    await fs.promises.rename(filePath, movedPath);
    const deletedAt = new Date().toISOString();
    const metadata = {
        id: recycleId,
        original_path: toWorkspaceRelative(filePath),
        deleted_at: deletedAt,
        type: isDirectory ? "dir" : "file",
        name,
    };
    await fs.promises.writeFile(
        path.join(recycleEntry, "metadata.json"),
        JSON.stringify(metadata, null, 2),
        "utf8"
    );
    await cleanupRecycleBin();
    return {
        recycle_id: recycleId,
        deleted_at: deletedAt,
        metadata,
    };
}

export async function readRecycleMetadata(entryPath: string) {
    const metadataPath = path.join(entryPath, "metadata.json");
    try {
        const raw = await fs.promises.readFile(metadataPath, "utf8");
        return JSON.parse(raw) as {
            id?: string;
            original_path?: string;
            deleted_at?: string;
            type?: "file" | "dir";
            name?: string;
        };
    } catch {
        return null;
    }
}

export async function findRecycleItem(entryPath: string) {
    const dirents = await fs.promises.readdir(entryPath, { withFileTypes: true });
    const item = dirents.find((entry) => entry.name !== "metadata.json");
    if (!item) {
        return null;
    }
    return {
        name: item.name,
        isDirectory: item.isDirectory(),
    };
}

export async function docListTrash(args: Record<string, unknown>) {
    try {
        const recycleRoot = await ensureRecycleBin();
        const limit = parsePositiveInt(args.limit, DEFAULT_LIST_LIMIT, 1);
        const offset = parsePositiveInt(args.offset, 0, 0);
        const dirents = await fs.promises.readdir(recycleRoot, {
            withFileTypes: true,
        });
        const entries: Array<{
            recycle_id: string;
            original_path: string;
            deleted_at: string;
            type: "file" | "dir";
            name?: string;
        }> = [];
        for (const entry of dirents) {
            if (!entry.isDirectory()) {
                continue;
            }
            const entryPath = path.join(recycleRoot, entry.name);
            const metadata = await readRecycleMetadata(entryPath);
            if (!metadata || !metadata.original_path) {
                continue;
            }
            const item = await findRecycleItem(entryPath);
            const type =
                metadata.type ?? (item?.isDirectory ? "dir" : "file");
            entries.push({
                recycle_id: metadata.id ?? entry.name,
                original_path: metadata.original_path,
                deleted_at: metadata.deleted_at ?? "",
                type,
                name: metadata.name ?? item?.name,
            });
        }
        entries.sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));
        const sliced = entries.slice(offset, offset + limit);
        return {
            entries: sliced,
            truncated: entries.length > offset + limit,
            offset,
            limit,
        };
    } catch (error) {
        return {
            error:
                error instanceof Error ? error.message : "Failed to list recycle bin.",
        };
    }
}

export async function docRestore(args: Record<string, unknown>) {
    try {
        const recycleId = toStringValue(args.recycle_id);
        const originalInput = toStringValue(args.original_path || args.path);
        if (!recycleId && !originalInput) {
            return { error: "recycle_id or original_path is required." };
        }
        const recycleRoot = await ensureRecycleBin();
        let entryPath = "";
        let metadata = null as Awaited<ReturnType<typeof readRecycleMetadata>>;

        if (recycleId) {
            entryPath = path.join(recycleRoot, recycleId);
            metadata = await readRecycleMetadata(entryPath);
        } else if (originalInput) {
            const targetPath = toWorkspaceRelativeInput(originalInput);
            const dirents = await fs.promises.readdir(recycleRoot, {
                withFileTypes: true,
            });
            let bestTimestamp = -1;
            for (const entry of dirents) {
                if (!entry.isDirectory()) {
                    continue;
                }
                const candidatePath = path.join(recycleRoot, entry.name);
                const candidate = await readRecycleMetadata(candidatePath);
                if (!candidate || candidate.original_path !== targetPath) {
                    continue;
                }
                const ts = candidate.deleted_at ? Date.parse(candidate.deleted_at) : 0;
                if (ts >= bestTimestamp) {
                    bestTimestamp = ts;
                    entryPath = candidatePath;
                    metadata = candidate;
                }
            }
        }

        if (!metadata || !metadata.original_path) {
            return { error: "Recycle entry not found." };
        }

        const item = await findRecycleItem(entryPath);
        if (!item) {
            return { error: "Recycle entry is missing its item." };
        }

        const destinationInput = toStringValue(args.destination_path);
        const destinationPath = destinationInput
            ? resolveWorkspacePath(destinationInput)
            : resolveWorkspacePath(metadata.original_path);
        const root = resolveWorkspaceRoot();
        if (destinationPath === root) {
            return { error: "Destination cannot be the workspace root." };
        }
        await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
        const overwrite = Boolean(args.overwrite);
        if (await pathExists(destinationPath)) {
            if (!overwrite) {
                return { error: "Destination already exists. Set overwrite to true." };
            }
            await moveToRecycle(destinationPath);
        }
        await fs.promises.rename(
            path.join(entryPath, item.name),
            destinationPath
        );
        await fs.promises.rm(entryPath, { recursive: true, force: true });
        return {
            success: true,
            restored_path: toWorkspaceRelative(destinationPath),
            original_path: metadata.original_path,
            recycle_id: metadata.id ?? recycleId,
        };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "Failed to restore path.",
        };
    }
}

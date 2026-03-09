import {
  createManagedUser,
  deleteManagedUser,
  ensureAuthReady,
  getUserCount,
  isBootstrapConfigured,
  setManagedUserPassword,
} from "./auth";
import { ToolDefinition } from "./openrouter";

export const USER_TOOL_NAMES = ["create_user"] as const;

function pickUsername(args: Record<string, unknown>) {
  const values = [args.username, args.login, args.user, args.user_name];
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function pickPassword(args: Record<string, unknown>) {
  const values = [args.password, args.new_password, args.pass];
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function pickAction(args: Record<string, unknown>) {
  const raw =
    typeof args.action === "string"
      ? args.action
      : typeof args.mode === "string"
        ? args.mode
        : "";
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return "create";
  }
  if (normalized === "create") {
    return "create";
  }
  if (normalized === "delete" || normalized === "remove") {
    return "delete";
  }
  if (
    normalized === "set_password" ||
    normalized === "update_password" ||
    normalized === "change_password"
  ) {
    return "set_password";
  }
  return normalized;
}

export function userToolsEnabled() {
  return process.env.USER_ADMIN_TOOLS_ENABLED !== "false";
}

export function getUserToolDefinitions(): ToolDefinition[] {
  if (!userToolsEnabled()) {
    return [];
  }

  return [
    {
      type: "function",
      function: {
        name: "create_user",
        description:
          "Manage app users. Supports create, delete, and set_password actions. Returns the exact login/password to share with the user.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["create", "delete", "set_password"],
              description:
                "Operation to perform. Use create to add a user, delete to remove, set_password to rotate credentials.",
            },
            username: {
              type: "string",
              description:
                "Login username for the operation. 3-64 chars, lowercase letters/numbers/dot/underscore/hyphen.",
            },
            password: {
              type: "string",
              description:
                "Password for create or set_password. If omitted, a secure password is generated and returned.",
            },
          },
          required: ["action", "username"],
        },
      },
    },
  ];
}

export async function runUserTool(name: string, args: Record<string, unknown>) {
  if (!userToolsEnabled()) {
    throw new Error("User admin tool is disabled.");
  }
  if (name !== "create_user") {
    throw new Error(`Unknown user tool: ${name}`);
  }

  const action = pickAction(args);
  const username = pickUsername(args);
  if (!username) {
    throw new Error("create_user requires a username.");
  }

  if (action === "create") {
    const result = await createManagedUser({
      username,
      password: pickPassword(args),
    });
    return {
      status: "ok",
      ...result,
    };
  }

  if (action === "delete") {
    const result = await deleteManagedUser({ username });
    return {
      status: "ok",
      ...result,
    };
  }

  if (action === "set_password") {
    const result = await setManagedUserPassword({
      username,
      password: pickPassword(args),
    });
    return {
      status: "ok",
      ...result,
    };
  }

  throw new Error(
    "Unsupported action. Use create, delete, or set_password for create_user."
  );
}

export async function getUserToolStatus() {
  if (!userToolsEnabled()) {
    return [
      {
        id: "user-admin",
        label: "User Admin",
        status: "error" as const,
        details: ["Disabled (USER_ADMIN_TOOLS_ENABLED=false)."],
      },
    ];
  }

  try {
    await ensureAuthReady();
    const count = await getUserCount();
    return [
      {
        id: "user-admin",
        label: "User Admin",
        status: "ok" as const,
        details: [
          `Enabled. ${count} user${count === 1 ? "" : "s"} in database.`,
          isBootstrapConfigured()
            ? "Bootstrap credentials are configured via .env."
            : "Bootstrap credentials are missing in .env.",
        ],
      },
    ];
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to initialize auth.";
    return [
      {
        id: "user-admin",
        label: "User Admin",
        status: "error" as const,
        details: [message],
      },
    ];
  }
}

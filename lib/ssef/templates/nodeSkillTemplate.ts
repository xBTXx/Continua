export type BuildNodeSkillTemplateInput = {
  skillId: string;
  version: string;
  problem: string;
  desiredOutcome: string;
  constraints: string[];
  priority: string;
};

function asEscapedLiteral(value: string) {
  return JSON.stringify(value);
}

function asEscapedStringArray(values: string[]) {
  return `[${values.map((entry) => asEscapedLiteral(entry)).join(", ")}]`;
}

export function buildNodeSkillEntrypointTemplate(
  input: BuildNodeSkillTemplateInput
) {
  const skillId = asEscapedLiteral(input.skillId);
  const version = asEscapedLiteral(input.version);
  const problem = asEscapedLiteral(input.problem);
  const desiredOutcome = asEscapedLiteral(input.desiredOutcome);
  const priority = asEscapedLiteral(input.priority);
  const constraints = asEscapedStringArray(input.constraints);

  return [
    "function readStdin() {",
    "  return new Promise((resolve, reject) => {",
    "    let text = \"\";",
    "    process.stdin.setEncoding(\"utf8\");",
    "    process.stdin.on(\"data\", (chunk) => {",
    "      text += chunk;",
    "    });",
    "    process.stdin.on(\"end\", () => resolve(text));",
    "    process.stdin.on(\"error\", reject);",
    "  });",
    "}",
    "",
    "function asRecord(value) {",
    "  return value && typeof value === \"object\" && !Array.isArray(value) ? value : {};",
    "}",
    "",
    "function clipText(value, maxChars) {",
    "  if (typeof value !== \"string\") {",
    "    return \"\";",
    "  }",
    "  if (value.length <= maxChars) {",
    "    return value;",
    "  }",
    "  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;",
    "}",
    "",
    "function summarize(inputKeys, constraints, objective, priority) {",
    "  const inputSummary =",
    "    inputKeys.length > 0",
    "      ? `Processed ${inputKeys.length} input key(s): ${inputKeys.slice(0, 6).join(\", \")}.`",
    "      : \"No structured input keys were provided.\";",
    "  const constraintSummary =",
    "    constraints.length > 0",
    "      ? `Constraints honored: ${constraints.join(\"; \")}.`",
    "      : \"No explicit constraints were provided.\";",
    "  return clipText(",
    "    `${objective} [priority=${priority}] ${inputSummary} ${constraintSummary}`,",
    "    600",
    "  );",
    "}",
    "",
    "async function main() {",
    `  const skillId = ${skillId};`,
    `  const version = ${version};`,
    `  const problem = ${problem};`,
    `  const desiredOutcome = ${desiredOutcome};`,
    `  const priority = ${priority};`,
    `  const constraints = ${constraints};`,
    "",
    "  const stdin = await readStdin();",
    "  let payload = {};",
    "  if (stdin && stdin.trim()) {",
    "    try {",
    "      payload = JSON.parse(stdin);",
    "    } catch (error) {",
    "      throw new Error(\"Invalid JSON payload received by skill entrypoint.\");",
    "    }",
    "  }",
    "",
    "  const args = asRecord(payload.args);",
    "  const inputKeys = Object.keys(args);",
    "  const receivedInputs = {};",
    "  inputKeys.slice(0, 20).forEach((key) => {",
    "    receivedInputs[key] = args[key];",
    "  });",
    "",
    "  const result = {",
    "    status: \"ok\",",
    "    skill_id: skillId,",
    "    version,",
    "    problem,",
    "    objective: desiredOutcome,",
    "    priority,",
    "    constraints,",
    "    summary: summarize(inputKeys, constraints, desiredOutcome, priority),",
    "    received_input_keys: inputKeys,",
    "    received_inputs: receivedInputs,",
    "    generated_at: new Date().toISOString(),",
    "  };",
    "",
    "  process.stdout.write(JSON.stringify(result));",
    "}",
    "",
    "main().catch((error) => {",
    "  const message = error instanceof Error ? error.message : String(error);",
    "  process.stderr.write(`${message}\\n`);",
    "  process.exit(1);",
    "});",
    "",
  ].join("\n");
}

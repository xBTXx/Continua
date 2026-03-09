const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.API_KEY;

if (!apiKey) {
  console.error(
    "Missing OPENROUTER_API_KEY or API_KEY. Set one to run the memory loop smoke test."
  );
  process.exit(1);
}

async function postJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${path} failed: ${response.status} ${text}`);
  }

  return response.json();
}

const seedMessages = [
  { role: "user", content: "My name is Taylor and I prefer green tea." },
  {
    role: "assistant",
    content: "Got it. I'll remember your name and beverage preference.",
  },
  {
    role: "user",
    content: "Please keep meetings after 2pm whenever possible.",
  },
  {
    role: "assistant",
    content: "Understood. I'll aim for meetings after 2pm.",
  },
  {
    role: "user",
    content: "I am working on the assistant MVP this week.",
  },
];

const memoryResult = await postJson("/api/memory", {
  messages: seedMessages,
  apiKey,
  appUrl: baseUrl,
});

console.log("Memory agent result:", memoryResult);

const debugResult = await postJson("/api/chat", {
  model: "google/gemini-3-flash-preview",
  messages: [
    {
      role: "system",
      content: "You are a memory-aware assistant.",
    },
    { role: "user", content: "What do you know about me so far?" },
  ],
  stream: false,
  apiKey,
  appUrl: baseUrl,
  debug: true,
});

if (!debugResult.memories || debugResult.memories.length === 0) {
  console.warn(
    "No memories retrieved. If the memory agent stored none, this is expected."
  );
} else {
  console.log("Retrieved memories:", debugResult.memories);
}

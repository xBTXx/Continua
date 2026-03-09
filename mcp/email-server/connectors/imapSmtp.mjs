import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { simpleParser } from "mailparser";

function requireCredentials(envPrefix) {
  const usernameKey = `${envPrefix}_USERNAME`;
  const passwordKey = `${envPrefix}_PASSWORD`;
  const username = process.env[usernameKey];
  const password = process.env[passwordKey];

  if (!username || !password) {
    throw new Error(
      `Missing credentials. Set ${usernameKey} and ${passwordKey} in the environment.`
    );
  }

  return { username, password };
}

function requireImapConfig(account) {
  if (!account.imap?.host || !account.imap?.port) {
    throw new Error(`IMAP config missing for account ${account.id}.`);
  }

  return {
    host: account.imap.host,
    port: account.imap.port,
    secure: Boolean(account.imap.secure),
    draftsFolder: account.imap.drafts_folder || "Drafts",
    sentFolder: account.imap.sent_folder || "Sent",
  };
}

function requireSmtpConfig(account) {
  if (!account.smtp?.host || !account.smtp?.port) {
    throw new Error(`SMTP config missing for account ${account.id}.`);
  }

  return {
    host: account.smtp.host,
    port: account.smtp.port,
    secure: Boolean(account.smtp.secure),
  };
}

function formatAddress(account) {
  if (account.display_name) {
    return `${account.display_name} <${account.email}>`;
  }
  return account.email;
}

async function withImapClient({ account, envPrefix }, task) {
  const { username, password } = requireCredentials(envPrefix);
  const imapConfig = requireImapConfig(account);
  const client = new ImapFlow({
    host: imapConfig.host,
    port: imapConfig.port,
    secure: imapConfig.secure,
    auth: { user: username, pass: password },
  });

  await client.connect();

  try {
    return await task(client, imapConfig);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function buildRawMessage({
  account,
  to,
  cc,
  bcc,
  subject,
  body,
  bodyFormat,
  inReplyTo,
  references,
  replyTo,
}) {
  const format = bodyFormat === "html" ? "html" : "text";
  const composer = new MailComposer({
    from: formatAddress(account),
    to,
    cc,
    bcc,
    subject,
    text: format === "html" ? undefined : body,
    html: format === "html" ? body : undefined,
    inReplyTo,
    references,
    replyTo,
  });

  return composer.compile().build();
}

function mapEnvelopeAddress(addresses = []) {
  return addresses.map((entry) => ({
    name: entry.name || null,
    address: entry.address || null,
  }));
}

function mapEnvelope(envelope) {
  return {
    subject: envelope.subject || "",
    from: mapEnvelopeAddress(envelope.from),
    to: mapEnvelopeAddress(envelope.to),
    cc: mapEnvelopeAddress(envelope.cc),
    bcc: mapEnvelopeAddress(envelope.bcc),
    messageId: envelope.messageId || null,
    date: envelope.date ? envelope.date.toISOString() : null,
  };
}

function normalizeEnvelopeAddress(entry) {
  if (!entry) {
    return null;
  }
  if (entry.address) {
    return entry.address;
  }
  if (entry.mailbox && entry.host) {
    return `${entry.mailbox}@${entry.host}`;
  }
  return null;
}

function collectEnvelopeAddresses(list = []) {
  return list
    .map((entry) => normalizeEnvelopeAddress(entry))
    .filter((address) => typeof address === "string" && address.length > 0);
}

function normalizeParsedAddresses(list = []) {
  return list
    .map((entry) => (entry?.address ? String(entry.address) : null))
    .filter((address) => typeof address === "string" && address.length > 0);
}

function normalizeRecipientList(list = []) {
  return list
    .map((entry) => (typeof entry === "string" ? entry.trim() : null))
    .filter((address) => typeof address === "string" && address.length > 0);
}

const DATE_QUERY_REGEX =
  /\b(after|before|on|since)\s*:\s*(\d{4}-\d{2}-\d{2})\b/gi;

function addDays(date, days) {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function parseIsoDate(value) {
  if (!value || typeof value !== "string") {
    return null;
  }
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day, 0, 0, 0));
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function buildSearchQuery(query) {
  if (!query || typeof query !== "string") {
    return null;
  }

  DATE_QUERY_REGEX.lastIndex = 0;
  const criteria = {};
  let match;
  while ((match = DATE_QUERY_REGEX.exec(query)) !== null) {
    const term = match[1].toLowerCase();
    const date = parseIsoDate(match[2]);
    if (!date) {
      continue;
    }
    if (term === "after") {
      criteria.since = addDays(date, 1);
    } else if (term === "since") {
      criteria.since = date;
    } else if (term === "before") {
      criteria.before = date;
    } else if (term === "on") {
      criteria.on = date;
    }
  }

  const cleaned = query.replace(DATE_QUERY_REGEX, " ").replace(/\s+/g, " ").trim();
  if (cleaned) {
    criteria.text = cleaned;
  }

  return Object.keys(criteria).length > 0 ? criteria : null;
}

function buildEnvelope(fromAddress, { to = [], cc = [], bcc = [] }) {
  const recipients = Array.from(
    new Set([
      ...normalizeRecipientList(to),
      ...normalizeRecipientList(cc),
      ...normalizeRecipientList(bcc),
    ])
  );

  if (recipients.length === 0) {
    throw new Error("No recipients defined");
  }

  return {
    from: fromAddress,
    to: recipients,
  };
}

const SENT_FOLDER_NAMES = [
  "sent",
  "sent items",
  "sent messages",
  "sent mail",
  "sentmail",
  "sent-mail",
  "wyslane",
  "wyslane wiadomosci",
];

function normalizeFolderName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[./\\_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSentFolder(folder) {
  if (!folder) {
    return false;
  }
  const specialUse = String(folder.specialUse || "").toLowerCase();
  if (specialUse === "\\sent") {
    return true;
  }
  if (Array.isArray(folder.flags)) {
    const hasSentFlag = folder.flags.some(
      (flag) => String(flag).toLowerCase() === "\\sent"
    );
    if (hasSentFlag) {
      return true;
    }
  }
  const normalized = normalizeFolderName(folder.path);
  if (!normalized) {
    return false;
  }
  if (SENT_FOLDER_NAMES.includes(normalized)) {
    return true;
  }
  return SENT_FOLDER_NAMES.some((name) => normalized.endsWith(` ${name}`));
}

async function resolveSentFolder(client, preferred) {
  const normalizedPreferred = normalizeFolderName(preferred);
  const folders = await client.list();
  const flagged = folders.find(isSentFolder);
  if (flagged?.path) {
    return flagged.path;
  }
  if (normalizedPreferred) {
    const preferredMatch = folders.find(
      (folder) => normalizeFolderName(folder.path) === normalizedPreferred
    );
    if (preferredMatch?.path) {
      return preferredMatch.path;
    }
  }
  return null;
}

async function appendToSent(client, imapConfig, raw) {
  const flags = ["\\Seen"];
  try {
    await client.append(imapConfig.sentFolder, raw, flags);
    return { sentFolder: imapConfig.sentFolder, warning: null };
  } catch (error) {
    let fallbackFolder = null;
    try {
      fallbackFolder = await resolveSentFolder(client, imapConfig.sentFolder);
    } catch (resolveError) {
      console.warn("Sent folder lookup failed.", resolveError);
    }

    if (fallbackFolder && fallbackFolder !== imapConfig.sentFolder) {
      try {
        await client.append(fallbackFolder, raw, flags);
        return {
          sentFolder: fallbackFolder,
          warning: `Sent copy saved to "${fallbackFolder}" because "${imapConfig.sentFolder}" was missing.`,
        };
      } catch (appendError) {
        console.warn("Append to fallback sent folder failed.", appendError);
      }
    }

    console.warn("Append to sent folder failed.", error);
    return {
      sentFolder: null,
      warning: `Sent but could not save a copy to "${imapConfig.sentFolder}".`,
    };
  }
}

export async function listFolders({ account, envPrefix }) {
  return withImapClient({ account, envPrefix }, async (client) => {
    const folders = await client.list();
    return folders.map((folder) => ({
      name: folder.path,
      delimiter: folder.delimiter,
      flags: folder.flags,
      specialUse: folder.specialUse || null,
    }));
  });
}

export async function listMessages({
  account,
  envPrefix,
  folder,
  limit,
  query,
}) {
  return withImapClient({ account, envPrefix }, async (client) => {
    const mailbox = await client.mailboxOpen(folder);
    let messageUids = [];

    if (query) {
      const searchQuery = buildSearchQuery(query);
      if (searchQuery) {
        messageUids = await client.search(searchQuery);
      } else {
        messageUids = await client.search({ text: query });
      }
      messageUids = messageUids.slice(-limit);
    } else {
      const total = mailbox.exists;
      if (total === 0) {
        return [];
      }
      const start = Math.max(1, total - limit + 1);
      const sequenceRange = `${start}:${total}`;
      for await (const msg of client.fetch(sequenceRange, { uid: true })) {
        messageUids.push(msg.uid);
      }
    }

    if (messageUids.length === 0) {
      return [];
    }

    const results = [];
    for await (const msg of client.fetch(
      messageUids,
      { envelope: true, flags: true, uid: true, internalDate: true },
      { uid: true }
    )) {
      results.push({
        id: String(msg.uid),
        folder,
        envelope: mapEnvelope(msg.envelope),
        flags: msg.flags || [],
        receivedAt: msg.internalDate
          ? msg.internalDate.toISOString()
          : null,
      });
    }

    return results.reverse();
  });
}

export async function getMessage({ account, envPrefix, folder, messageId }) {
  return withImapClient({ account, envPrefix }, async (client) => {
    const uid = Number(messageId);
    if (!Number.isFinite(uid)) {
      throw new Error("IMAP message_id must be a numeric UID.");
    }

    await client.mailboxOpen(folder);
    const message = await client.fetchOne(
      uid,
      { source: true, envelope: true, flags: true, internalDate: true, uid: true },
      { uid: true }
    );

    if (!message?.source) {
      throw new Error("Message source not available.");
    }

    const parsed = await simpleParser(message.source);

    return {
      id: String(message.uid),
      folder,
      envelope: mapEnvelope(message.envelope),
      flags: message.flags || [],
      receivedAt: message.internalDate
        ? message.internalDate.toISOString()
        : null,
      text: parsed.text || "",
      html: parsed.html || "",
      attachments: (parsed.attachments || []).map((attachment) => ({
        filename: attachment.filename || null,
        contentType: attachment.contentType,
        size: attachment.size,
      })),
      messageId: parsed.messageId || null,
      inReplyTo: parsed.inReplyTo || null,
      references: parsed.references || [],
    };
  });
}

export async function createDraft({
  account,
  envPrefix,
  to,
  cc,
  bcc,
  subject,
  body,
  bodyFormat,
  replyToMessageId,
}) {
  return withImapClient({ account, envPrefix }, async (client, imapConfig) => {
    let inReplyTo;
    let references;
    let replyTo;

    if (replyToMessageId) {
      const uid = Number(replyToMessageId);
      if (Number.isFinite(uid)) {
        await client.mailboxOpen("INBOX");
        const replyMessage = await client.fetchOne(
          uid,
          { source: true, envelope: true, uid: true },
          { uid: true }
        );
        if (replyMessage?.source) {
          const parsed = await simpleParser(replyMessage.source);
          inReplyTo = parsed.messageId || replyMessage.envelope?.messageId || null;
          references = parsed.references || (inReplyTo ? [inReplyTo] : undefined);
          replyTo =
            parsed.replyTo?.value?.map((item) => item.address) ||
            parsed.from?.value?.map((item) => item.address) ||
            undefined;
        }
      }
    }

    const raw = await buildRawMessage({
      account,
      to,
      cc,
      bcc,
      subject,
      body,
      bodyFormat,
      inReplyTo,
      references,
      replyTo,
    });

    const appendResult = await client.append(
      imapConfig.draftsFolder,
      raw,
      ["\\Draft"]
    );

    return {
      id: String(appendResult.uid),
      folder: imapConfig.draftsFolder,
    };
  });
}

export async function sendMessage({
  account,
  envPrefix,
  draftId,
  to,
  cc,
  bcc,
  subject,
  body,
  bodyFormat,
}) {
  const { username, password } = requireCredentials(envPrefix);
  const smtpConfig = requireSmtpConfig(account);

  const transporter = nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    auth: { user: username, pass: password },
  });

  if (draftId) {
    return withImapClient({ account, envPrefix }, async (client, imapConfig) => {
      const draftUid = Number(draftId);
      if (!Number.isFinite(draftUid)) {
        throw new Error("Draft id must be a numeric UID.");
      }
      await client.mailboxOpen(imapConfig.draftsFolder);
      const draft = await client.fetchOne(
        draftUid,
        { source: true, uid: true },
        { uid: true }
      );
      if (!draft?.source) {
        throw new Error("Draft source not found.");
      }

      const parsed = await simpleParser(draft.source);
      const envelope = buildEnvelope(account.email, {
        to: normalizeParsedAddresses(parsed.to?.value),
        cc: normalizeParsedAddresses(parsed.cc?.value),
        bcc: normalizeParsedAddresses(parsed.bcc?.value),
      });

      await transporter.sendMail({ raw: draft.source, envelope });

      const { warning, sentFolder } = await appendToSent(
        client,
        imapConfig,
        draft.source
      );

      const result = { id: String(draftUid), sent: true };
      if (warning) {
        result.warning = warning;
      }
      if (sentFolder) {
        result.sent_folder = sentFolder;
      }
      return result;
    });
  }

  const raw = await buildRawMessage({
    account,
    to,
    cc,
    bcc,
    subject,
    body,
    bodyFormat,
  });

  const envelope = buildEnvelope(account.email, { to, cc, bcc });
  await transporter.sendMail({ raw, envelope });

  return withImapClient({ account, envPrefix }, async (client, imapConfig) => {
    const { warning, sentFolder } = await appendToSent(
      client,
      imapConfig,
      raw
    );
    const result = { id: null, sent: true };
    if (warning) {
      result.warning = warning;
    }
    if (sentFolder) {
      result.sent_folder = sentFolder;
    }
    return result;
  });
}

export async function reply({ account, envPrefix, messageId, body, replyAll }) {
  return withImapClient({ account, envPrefix }, async (client, imapConfig) => {
    const uid = Number(messageId);
    if (!Number.isFinite(uid)) {
      throw new Error("IMAP message_id must be a numeric UID.");
    }

    await client.mailboxOpen("INBOX");
    const message = await client.fetchOne(
      uid,
      { source: true, envelope: true, uid: true },
      { uid: true }
    );

    if (!message?.source) {
      throw new Error("Message source not found.");
    }

    const parsed = await simpleParser(message.source);
    const replyToList = normalizeParsedAddresses(parsed.replyTo?.value);
    const fromList = normalizeParsedAddresses(parsed.from?.value);
    const envelopeFrom = collectEnvelopeAddresses(message.envelope?.from);
    const fromAddress =
      replyToList.length > 0
        ? replyToList
        : fromList.length > 0
          ? fromList
          : envelopeFrom;
    const envelopeTo = collectEnvelopeAddresses(message.envelope?.to);
    const envelopeCc = collectEnvelopeAddresses(message.envelope?.cc);
    const toParsed = normalizeParsedAddresses(parsed.to?.value);
    const ccParsed = normalizeParsedAddresses(parsed.cc?.value);
    const toList = toParsed.length > 0 ? toParsed : envelopeTo;
    const ccList = ccParsed.length > 0 ? ccParsed : envelopeCc;
    const ccAddresses = replyAll
      ? Array.from(new Set([...(toList || []), ...(ccList || [])])).filter(
          (address) => !fromAddress.includes(address)
        )
      : [];

    const rawSubject =
      parsed.subject || message.envelope?.subject || "Reply";
    const subject = rawSubject.startsWith("Re:")
      ? rawSubject
      : `Re: ${rawSubject}`.trim();

    const toAddresses = fromAddress.filter(
      (address) => typeof address === "string" && address.length > 0
    );
    if (toAddresses.length === 0) {
      throw new Error("Reply recipient not found in message headers.");
    }

    const raw = await buildRawMessage({
      account,
      to: toAddresses,
      cc: ccAddresses,
      bcc: [],
      subject,
      body,
      bodyFormat: "text",
      inReplyTo: parsed.messageId || null,
      references: parsed.references || [],
    });

    const { username, password } = requireCredentials(envPrefix);
    const smtpConfig = requireSmtpConfig(account);
    const transporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.secure,
      auth: { user: username, pass: password },
    });

    const envelope = buildEnvelope(account.email, {
      to: toAddresses,
      cc: ccAddresses,
      bcc: [],
    });
    await transporter.sendMail({ raw, envelope });

    const { warning, sentFolder } = await appendToSent(
      client,
      imapConfig,
      raw
    );

    const result = { id: String(messageId), sent: true };
    if (warning) {
      result.warning = warning;
    }
    if (sentFolder) {
      result.sent_folder = sentFolder;
    }
    return result;
  });
}

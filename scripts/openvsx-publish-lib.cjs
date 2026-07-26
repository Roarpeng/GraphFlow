/**
 * Shared Open VSX publish helpers (CJS for Windows vitest + CLI script).
 */

function resolveOpenVsxToken(env = process.env) {
  return env.open_vsx_token || env.OPEN_VSX_TOKEN || env.OVSX_PAT || "";
}

function openVsxHasVersion(metadata, targetVersion) {
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  if (metadata.version === targetVersion) {
    return true;
  }
  const all = metadata.allVersions;
  return Boolean(all && typeof all === "object" && all[targetVersion]);
}

function alignPackageJsonForNamespace(pkg, namespace) {
  const next = JSON.parse(JSON.stringify(pkg));
  const previousPublisher = String(next.publisher ?? "");
  const name = String(next.name ?? "graphflow-tool");
  const previousChatId = `${previousPublisher}.${name}.graphflowAgent`;
  const nextChatId = `${namespace}.${name}.graphflowAgent`;

  next.publisher = namespace;

  if (Array.isArray(next.activationEvents)) {
    next.activationEvents = next.activationEvents.map((event) =>
      typeof event === "string" ? event.split(previousChatId).join(nextChatId) : event
    );
  }

  const participants = next.contributes?.chatParticipants;
  if (Array.isArray(participants)) {
    for (const participant of participants) {
      if (participant && typeof participant.id === "string") {
        participant.id = participant.id.split(previousChatId).join(nextChatId);
      }
    }
  }

  return next;
}

module.exports = {
  resolveOpenVsxToken,
  openVsxHasVersion,
  alignPackageJsonForNamespace,
};

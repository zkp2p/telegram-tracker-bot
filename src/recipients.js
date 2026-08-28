const OFFICIAL_GROUP_CHAT_ID = -1001928949520;

function includeOfficialGroup(chatIds) {
  return Array.from(new Set([...chatIds, OFFICIAL_GROUP_CHAT_ID]));
}

function isOfficialGroup(chatId) {
  return chatId === OFFICIAL_GROUP_CHAT_ID;
}

module.exports = {
  OFFICIAL_GROUP_CHAT_ID,
  includeOfficialGroup,
  isOfficialGroup
};

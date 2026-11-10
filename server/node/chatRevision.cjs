'use strict';
// Revision of a stored chat, for compare-and-swap on /api/chat-content.
//
// A chat-content save owns the messages and every chat field except the ones
// the server takes from the database stub (mergeChatStubWithFullChat) and
// transient runtime flags. The revision is a hash of that owned content only,
// so a persist that rewrites stub fields, or a streaming flag, never makes a
// client's base look stale.
//
// The value must survive a restart: a save stores the decoded msgpack as is,
// while a restart loads the same chat through normalizeJSON (Date becomes an
// ISO string, binary a plain object). Hashing the normalised form on both
// paths gives one value. canon() treats absent and null alike.

const nodeCrypto = require('crypto');
const { canon } = require('./chatFingerprint.cjs');
const { normalizeJSON } = require('./utils.cjs');

const STUB_OWNED_FIELDS = Object.freeze(['id', 'name', 'lastDate', 'folderId', 'modules']);
const TRANSIENT_FIELDS = Object.freeze(['isStreaming', '_placeholder', '_stub']);
const NOT_OWNED = new Set([...STUB_OWNED_FIELDS, ...TRANSIENT_FIELDS]);

function ownedChatContent(chat) {
    const owned = {};
    if (!chat || typeof chat !== 'object') return owned;
    for (const key of Object.keys(chat)) {
        if (!NOT_OWNED.has(key)) owned[key] = chat[key];
    }
    return owned;
}

function chatRevision(chat) {
    return nodeCrypto.createHash('sha256').update(canon(normalizeJSON(ownedChatContent(chat)))).digest('hex');
}

module.exports = { chatRevision, ownedChatContent, STUB_OWNED_FIELDS, TRANSIENT_FIELDS };

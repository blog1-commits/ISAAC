const { query } = require('./db');
const config = require('../config/config');
const { isBotAdmin, getBotIdentifiers } = require('./isAdmin');

const DEMOTE_DEFAULTS = { enabled: false, action: 'promote', warnLimit: 3, warns: {} };
const PROMOTE_DEFAULTS = { enabled: false, action: 'demote', warnLimit: 3, warns: {} };

// Checks ONLY the bot owner number — no dev-list exemption, by design.
// Inlined here since it's only ever used by this listener.
function isPrimaryOwnerJid(jid) {
  if (!jid) return false;
  const number = String(jid).split('@')[0].split(':')[0];
  return number === config.ownerNumber;
}

async function getSettings(jid, key, defaults) {
  const { rows } = await query(
    'SELECT value FROM group_settings WHERE jid = $1 AND key = $2',
    [jid, key]
  );
  return rows[0] ? { ...defaults, ...rows[0].value } : { ...defaults };
}

async function setSettings(jid, key, patch, defaults) {
  const current = await getSettings(jid, key, defaults);
  const next = { ...current, ...patch };

  await query(
    `INSERT INTO group_settings (jid, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (jid, key) DO UPDATE SET value = EXCLUDED.value`,
    [jid, key, next]
  );

  return next;
}

/**
 * Registers the antidemote/antipromote enforcement listener on a live socket.
 * Call this once after your socket connects, e.g. in index.js:
 *
 *   const { registerGroupEventGuard } = require('./utils/groupEventGuard');
 *   registerGroupEventGuard(sock);
 *
 * CAVEAT: this relies on Baileys' group-participants.update event including
 * an `author` field (the JID of whoever performed the promote/demote).
 * Support for this varies by Baileys version — test in your environment.
 * If `author` is ever missing/undefined, enforcement is skipped for that
 * event rather than guessing, to avoid false positives.
 */
function registerGroupEventGuard(sock) {
  sock.ev.on('group-participants.update', async (update) => {
    try {
      const { id: jid, participants, action, author } = update;

      if (!jid?.endsWith('@g.us')) return;
      if (action !== 'demote' && action !== 'promote') return;
      if (!author) return; // can't determine who did it — skip rather than guess

      const botIds = getBotIdentifiers(sock);
      const isBotAction = botIds.has(author);

      // Bot's own corrective calls below always skip — otherwise every
      // enforcement action would recursively re-trigger this listener.
      if (isBotAction) return;

      const metadata = await sock.groupMetadata(jid);
      if (!isBotAdmin(sock, metadata)) return; // can't enforce without admin rights

      if (action === 'demote') {
        // Only the bot owner is exempted — not devs, not group admins.
        if (isPrimaryOwnerJid(author)) return;

        const settings = await getSettings(jid, 'antidemote', DEMOTE_DEFAULTS);
        if (!settings.enabled) return;

        if (settings.action === 'promote') {
          await sock.groupParticipantsUpdate(jid, participants, 'promote');

          const demoterIsAdmin = metadata.participants.find(
            p => p.id === author && (p.admin === 'admin' || p.admin === 'superadmin')
          );
          if (demoterIsAdmin) {
            await sock.groupParticipantsUpdate(jid, [author], 'demote');
          }

          await sock.sendMessage(jid, {
            text: '🔄 Unauthorized demotion detected — victim re-promoted, demoter demoted.',
            mentions: [author, ...participants]
          });
        } else if (settings.action === 'remove') {
          await sock.groupParticipantsUpdate(jid, [author, ...participants], 'remove');
          await sock.sendMessage(jid, {
            text: '🚫 Unauthorized demotion detected — both users removed.',
            mentions: [author, ...participants]
          });
        } else if (settings.action === 'warn') {
          const warns = { ...settings.warns };
          warns[author] = (warns[author] || 0) + 1;

          if (warns[author] >= settings.warnLimit) {
            await sock.groupParticipantsUpdate(jid, [author], 'remove');
            warns[author] = 0;
            await sock.sendMessage(jid, {
              text: `🚫 @${author.split('@')[0]} reached the warn limit and was removed for unauthorized demotion.`,
              mentions: [author]
            });
          } else {
            await sock.groupParticipantsUpdate(jid, participants, 'promote');
            await sock.sendMessage(jid, {
              text: `⚠️ @${author.split('@')[0]} warned (${warns[author]}/${settings.warnLimit}) for unauthorized demotion. Victim re-promoted.`,
              mentions: [author, ...participants]
            });
          }

          await setSettings(jid, 'antidemote', { warns }, DEMOTE_DEFAULTS);
        }
      }

      if (action === 'promote') {
        // Owner/dev promotions are still authorized.
        if (isOwnerJid(author)) return;

        const settings = await getSettings(jid, 'antipromote', PROMOTE_DEFAULTS);
        if (!settings.enabled) return;

        if (settings.action === 'demote') {
          await sock.groupParticipantsUpdate(jid, [author, ...participants], 'demote');
          await sock.sendMessage(jid, {
            text: '⬇️ Unauthorized promotion detected — both users demoted.',
            mentions: [author, ...participants]
          });
        } else if (settings.action === 'remove') {
          await sock.groupParticipantsUpdate(jid, [author, ...participants], 'remove');
          await sock.sendMessage(jid, {
            text: '🚫 Unauthorized promotion detected — both users removed.',
            mentions: [author, ...participants]
          });
        } else if (settings.action === 'warn') {
          const warns = { ...settings.warns };
          warns[author] = (warns[author] || 0) + 1;

          if (warns[author] >= settings.warnLimit) {
            await sock.groupParticipantsUpdate(jid, [author], 'remove');
            warns[author] = 0;
            await sock.sendMessage(jid, {
              text: `🚫 @${author.split('@')[0]} reached the warn limit and was removed for unauthorized promotion.`,
              mentions: [author]
            });
          } else {
            await sock.groupParticipantsUpdate(jid, participants, 'demote');
            await sock.sendMessage(jid, {
              text: `⚠️ @${author.split('@')[0]} warned (${warns[author]}/${settings.warnLimit}) for unauthorized promotion. Promoted user demoted.`,
              mentions: [author, ...participants]
            });
          }

          await setSettings(jid, 'antipromote', { warns }, PROMOTE_DEFAULTS);
        }
      }
    } catch (err) {
      console.error('[groupEventGuard] error handling group-participants.update:', err);
    }
  });
}

module.exports = { registerGroupEventGuard };


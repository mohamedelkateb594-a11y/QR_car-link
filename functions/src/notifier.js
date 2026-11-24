'use strict';
/** Push delivery. The message text is NOT put in the push (lock-screen privacy); only the reason label. */
const REASON_TEXT = Object.freeze({
  blocked_me: 'سيارتك تسد الطريق',
  move_car: 'مطلوب تحريك السيارة',
  lights_on: 'أنوار السيارة مضاءة',
  issue: 'يوجد مشكلة في السيارة',
  other: 'طلب تواصل بخصوص سيارتك',
});
const DEAD_TOKEN_CODES = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);
const CHANNEL_ID = 'contact_requests'; // Android notification channel, created by the app in Phase 6

function createNotifier({ store, messaging, logger = console }) {
  return {
    async notifyOwner(ownerUid, { requestId, reason }) {
      const devices = await store.listDevices(ownerUid);
      let sent = 0;
      for (const d of devices) {
        try {
          await messaging.send({
            token: d.token,
            data: { type: 'contact_request', requestId, reason },
            notification: { title: 'طلب تواصل جديد', body: REASON_TEXT[reason] || REASON_TEXT.other },
            android: { priority: 'high', notification: { channelId: CHANNEL_ID } },
          });
          sent += 1;
        } catch (err) {
          const code = err && err.code;
          if (DEAD_TOKEN_CODES.has(code)) await store.deleteDevice(ownerUid, d.id);
          else logger.error('fcm_send_failed', { code });
        }
      }
      return { sent };
    },
  };
}

module.exports = { createNotifier, REASON_TEXT, CHANNEL_ID };

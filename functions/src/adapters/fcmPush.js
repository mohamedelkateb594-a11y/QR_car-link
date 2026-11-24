'use strict';
/**
 * FCM implementation of the `push` port. !! NOT RUN YET (see handoff). !!
 * Phase 2 sends a plain high-priority notification. The custom sound / Notification Channel (`channelId`)
 * is Phase 6: the channel id below must match the one the Android app creates.
 */
const ALERT_CHANNEL_ID = 'request_alerts';
const DEAD_TOKEN_CODES = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);

function createFcmPush({ db, messaging }) {
  return {
    async notifyOwner(ownerUid, payload) {
      const devices = await db.collection('users').doc(ownerUid).collection('devices').get();
      if (devices.empty) throw new Error('no_devices');
      const tokens = devices.docs.map((d) => d.get('token')).filter(Boolean);
      const isMessage = payload.type === 'message';
      const res = await messaging.sendEachForMulticast({
        tokens,
        // No personal data: only ids and the reason code.
        data: { type: payload.type, requestId: payload.requestId, attempt: String(payload.attempt), reason: String(payload.reason || '') },
        notification: {
          title: isMessage ? 'رسالة جديدة بخصوص سيارتك' : 'طلب تواصل بخصوص سيارتك',
          body: isMessage ? 'وصلتك رسالة جديدة' : 'افتح الطلب للتفاصيل',
        },
        android: { priority: 'high', notification: { channelId: ALERT_CHANNEL_ID } },
      });
      // Drop tokens FCM says are dead.
      await Promise.all(res.responses.map((r, i) =>
        (!r.success && r.error && DEAD_TOKEN_CODES.has(r.error.code)) ? devices.docs[i].ref.delete() : null));
      if (res.successCount === 0) throw new Error('push_all_failed');
    },
  };
}
module.exports = { createFcmPush, ALERT_CHANNEL_ID };

package com.mohamed.qrcar

import android.content.ContentValues
import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.net.Uri
import android.os.Environment
import android.os.PowerManager
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * The alert sound and the related user settings.
 *
 * Two ways to be heard, switchable in Settings:
 *  - channel mode (default): the sound is registered in the phone's media library (Notifications/QRCar) and attached
 *    to the notification channel, exactly like chat apps do, so the phone's own notification settings show it;
 *  - app mode: the app plays the sound itself on the alarm volume, and the channel stays silent so they never overlap.
 * The sound is either a short built-in two-tone alert (generated in code) or a file the owner picked from the phone.
 */
object Sound {
    private const val CUSTOM_FILE = "custom_alert"
    private const val TONE_FILE = "default_alert.wav"
    private const val MAX_BYTES = 5L * 1024 * 1024

    var inApp by mutableStateOf(false)
        private set
    var wake by mutableStateOf(false)
        private set
    var customName by mutableStateOf<String?>(null)
        private set

    /** True when the media-library registration failed, so the app must play the sound itself. */
    var registrationFailed = false
        private set

    /** Bumped whenever the sound changes: a notification channel keeps its sound forever, so a change needs a new one. */
    var version = 1
        private set

    private var player: MediaPlayer? = null

    private fun prefs(ctx: Context) = ctx.applicationContext.getSharedPreferences("qrcar_sound", Context.MODE_PRIVATE)

    fun load(ctx: Context) {
        val p = prefs(ctx)
        inApp = p.getBoolean("in_app", false)
        wake = p.getBoolean("wake", false)
        version = p.getInt("version", 1)
        customName = if (File(ctx.filesDir, CUSTOM_FILE).exists()) p.getString("name", "ملف صوتي") else null
    }

    fun setInApp(ctx: Context, v: Boolean) {
        inApp = v
        prefs(ctx).edit().putBoolean("in_app", v).apply()
    }

    fun setWake(ctx: Context, v: Boolean) {
        wake = v
        prefs(ctx).edit().putBoolean("wake", v).apply()
    }

    // ---------- the sound itself ----------
    /** Two alternating beeps (880 / 1175 Hz), mono 16-bit 22.05 kHz, about 2.3 seconds, loud. */
    private fun toneWav(): ByteArray {
        val rate = 22050
        val beep = rate / 4
        val gap = rate / 8
        val freqs = doubleArrayOf(880.0, 1175.0, 880.0, 1175.0, 880.0, 1175.0)
        val pcm = ShortArray(freqs.size * (beep + gap))
        var pos = 0
        for (f in freqs) {
            for (i in 0 until beep) {
                val fade = minOf(1.0, minOf(i, beep - 1 - i) / 200.0)
                val v = Math.sin(2.0 * Math.PI * f * i / rate) * fade * 0.9 * 32767.0
                pcm[pos + i] = v.toInt().toShort()
            }
            pos += beep + gap
        }
        val dataLen = pcm.size * 2
        val out = ByteBuffer.allocate(44 + dataLen).order(ByteOrder.LITTLE_ENDIAN)
        out.put("RIFF".toByteArray())
        out.putInt(36 + dataLen)
        out.put("WAVE".toByteArray())
        out.put("fmt ".toByteArray())
        out.putInt(16)
        out.putShort(1.toShort())
        out.putShort(1.toShort())
        out.putInt(rate)
        out.putInt(rate * 2)
        out.putShort(2.toShort())
        out.putShort(16.toShort())
        out.put("data".toByteArray())
        out.putInt(dataLen)
        for (s in pcm) out.putShort(s)
        return out.array()
    }

    private fun toneFile(ctx: Context): File {
        val f = File(ctx.filesDir, TONE_FILE)
        if (!f.exists()) f.writeBytes(toneWav())
        return f
    }

    /** The picked file, or the built-in tone. */
    private fun currentFile(ctx: Context): File {
        val custom = File(ctx.filesDir, CUSTOM_FILE)
        return if (custom.exists()) custom else toneFile(ctx)
    }

    private fun currentMime(ctx: Context): String =
        if (File(ctx.filesDir, CUSTOM_FILE).exists()) prefs(ctx).getString("mime", "audio/mpeg") ?: "audio/mpeg" else "audio/wav"

    /** Copies a file the owner picked. Returns an error message, or null on success. */
    fun saveCustom(ctx: Context, uri: Uri): String? {
        val resolver = ctx.contentResolver
        val mime = resolver.getType(uri) ?: ""
        if (!mime.startsWith("audio/")) return "اختر ملفًا صوتيًا (mp3 أو m4a أو ogg أو wav)"
        var name: String? = null
        try {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                if (it.moveToFirst()) name = it.getString(0)
            }
        } catch (e: Exception) {
            // The name is only for display.
        }
        val dest = File(ctx.filesDir, CUSTOM_FILE)
        val tmp = File(ctx.filesDir, "$CUSTOM_FILE.tmp")
        try {
            val input = resolver.openInputStream(uri) ?: return "تعذر قراءة الملف"
            var total = 0L
            input.use { src ->
                tmp.outputStream().use { dst ->
                    val buf = ByteArray(8192)
                    while (true) {
                        val n = src.read(buf)
                        if (n < 0) break
                        total += n
                        if (total > MAX_BYTES) {
                            tmp.delete()
                            return "الملف كبير. اختر ملفًا أقصر (الحد 5 ميغابايت)"
                        }
                        dst.write(buf, 0, n)
                    }
                }
            }
        } catch (e: Exception) {
            tmp.delete()
            return "تعذر قراءة الملف"
        }
        dest.delete()
        if (!tmp.renameTo(dest)) {
            tmp.delete()
            return "تعذر حفظ الملف"
        }
        prefs(ctx).edit().putString("name", name ?: "ملف صوتي").putString("mime", mime).apply()
        customName = name ?: "ملف صوتي"
        bump(ctx)
        return null
    }

    fun clearCustom(ctx: Context) {
        File(ctx.filesDir, CUSTOM_FILE).delete()
        customName = null
        bump(ctx)
    }

    /** A different sound needs a new library entry and a new channel. The old library entry is removed. */
    private fun bump(ctx: Context) {
        val p = prefs(ctx)
        p.getString("uri_$version", null)?.let {
            try {
                ctx.contentResolver.delete(Uri.parse(it), null, null)
            } catch (e: Exception) {
                // Nothing to clean up if it is already gone.
            }
        }
        p.edit().remove("uri_$version").putInt("version", version + 1).apply()
        version += 1
    }

    /** Library (MediaStore) address of the current sound for the notification channel, or null if it cannot be registered. */
    fun channelUri(ctx: Context): Uri? {
        val p = prefs(ctx)
        p.getString("uri_$version", null)?.let { return Uri.parse(it) }
        val uri = register(ctx)
        registrationFailed = uri == null
        if (uri != null) p.edit().putString("uri_$version", uri.toString()).apply()
        return uri
    }

    private fun register(ctx: Context): Uri? = try {
        val mime = currentMime(ctx)
        val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime) ?: "mp3"
        val values = ContentValues().apply {
            put(MediaStore.Audio.Media.DISPLAY_NAME, "qrcar_alert_$version.$ext")
            put(MediaStore.Audio.Media.MIME_TYPE, mime)
            put(MediaStore.Audio.Media.RELATIVE_PATH, Environment.DIRECTORY_NOTIFICATIONS + "/QRCar")
            put(MediaStore.Audio.Media.IS_NOTIFICATION, 1)
            put(MediaStore.Audio.Media.IS_PENDING, 1)
        }
        val resolver = ctx.contentResolver
        val uri = resolver.insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, values)
        if (uri == null) {
            null
        } else {
            val out = resolver.openOutputStream(uri)
            if (out == null) {
                resolver.delete(uri, null, null)
                null
            } else {
                out.use { it.write(currentFile(ctx).readBytes()) }
                val done = ContentValues().apply { put(MediaStore.Audio.Media.IS_PENDING, 0) }
                resolver.update(uri, done, null, null)
                uri
            }
        }
    } catch (e: Exception) {
        null
    }

    // ---------- playing from the app ----------
    /** Plays the sound on the alarm volume. A broken picked file falls back to the built-in tone. */
    fun play(ctx: Context) {
        stop()
        if (!start(ctx, currentFile(ctx))) start(ctx, toneFile(ctx))
    }

    private fun start(ctx: Context, file: File): Boolean = try {
        val mp = MediaPlayer()
        mp.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build(),
        )
        mp.setDataSource(file.path)
        mp.isLooping = false
        mp.setOnCompletionListener {
            it.release()
            if (player === it) player = null
        }
        mp.prepare()
        mp.start()
        player = mp
        true
    } catch (e: Exception) {
        false
    }

    fun stop() {
        try {
            player?.release()
        } catch (e: Exception) {
            // Already released.
        }
        player = null
    }

    /** Lights the screen for a few seconds so a request on a locked phone is noticed. */
    fun wakeScreen(ctx: Context) {
        try {
            val pm = ctx.getSystemService(PowerManager::class.java)
            if (pm.isInteractive) return
            @Suppress("DEPRECATION")
            val wl = pm.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE,
                "qrcar:alert",
            )
            wl.acquire(8000L)
        } catch (e: Exception) {
            // Waking the screen is optional.
        }
    }
}

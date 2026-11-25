package com.mohamed.qrcar

import android.util.Base64
import java.security.MessageDigest
import java.security.SecureRandom

/** A car kept ONLY on this phone (the database rules allow nothing but ownerUid/carId/active under links/). */
data class Car(val id: String, val label: String, val token: String) {
    val hash: String get() = Crypto.sha256Hex(token)
}

data class Req(
    val hash: String,
    val id: String,
    val reason: String,
    val note: String,
    val status: String,
    val createdAt: Long,
)

data class Msg(val id: String, val from: String, val text: String, val createdAt: Long)

object Crypto {
    private val rnd = SecureRandom()

    /** 24 random bytes -> 32 url-safe chars, exactly what the visitor page accepts: ^[A-Za-z0-9_-]{32}$ */
    fun newToken(): String {
        val b = ByteArray(24)
        rnd.nextBytes(b)
        return Base64.encodeToString(b, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    }

    /** Lower-case hex SHA-256 of the token's UTF-8 bytes (same as the page's sha256Hex). */
    fun sha256Hex(s: String): String =
        MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    fun randomHex(bytes: Int): String {
        val b = ByteArray(bytes)
        rnd.nextBytes(b)
        return b.joinToString("") { "%02x".format(it) }
    }
}

object Strs {
    val reasons = mapOf(
        "blocked_me" to "عربيتك قافلة على الزائر وهو محتاج يخرج",
        "move_car" to "محتاجين تحرك عربيتك لو سمحت",
        "lights_on" to "أنوار العربية مفتوحة",
        "issue" to "في مشكلة أو ملاحظة بخصوص عربيتك",
        "other" to "سبب آخر",
    )

    private val BAD = Regex("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\u202A-\\u202E\\u2066-\\u2069]")

    /** Same cleaning as the page: strip control + bidi-override characters, trim. */
    fun clean(s: String): String = s.replace(BAD, "").trim()

    fun fmt(seconds: Long): String {
        val s = if (seconds < 0) 0L else seconds
        return "%02d:%02d".format(s / 60, s % 60)
    }
}

/** Phase of a request as the visitor page computes it: expiry is createdAt + 15 min of SERVER time. */
fun Req.phase(now: Long): String = when {
    status == "closed_on_the_way" || status == "closed_resolved" || status == "cancelled" -> status
    now >= createdAt + Repo.TTL_MS -> "expired"
    else -> status
}

fun Req.isOpen(now: Long): Boolean = phase(now).let { it == "sent" || it == "viewed" }

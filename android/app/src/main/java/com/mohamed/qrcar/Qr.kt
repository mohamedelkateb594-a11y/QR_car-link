package com.mohamed.qrcar

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

fun qrBitmap(text: String, size: Int = 900): Bitmap {
    val hints = mapOf<EncodeHintType, Any>(
        EncodeHintType.MARGIN to 2,
        EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
        EncodeHintType.CHARACTER_SET to "UTF-8",
    )
    val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, hints)
    val px = IntArray(size * size) { i -> if (m.get(i % size, i / size)) Color.BLACK else Color.WHITE }
    return Bitmap.createBitmap(px, size, size, Bitmap.Config.ARGB_8888)
}

/** A ready-to-print card: the QR with a short instruction, and nothing that identifies the owner or the car. */
fun printableCard(qr: Bitmap): Bitmap {
    val w = qr.width
    val top = 150
    val bottom = 110
    val out = Bitmap.createBitmap(w, top + qr.height + bottom, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(out)
    canvas.drawColor(Color.WHITE)
    canvas.drawBitmap(qr, 0f, top.toFloat(), null)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.BLACK
        textAlign = Paint.Align.CENTER
        typeface = Typeface.DEFAULT_BOLD
        textSize = w / 18f
    }
    canvas.drawText("امسح للتواصل مع صاحب السيارة", w / 2f, top * 0.65f, paint)
    paint.textSize = w / 24f
    canvas.drawText("Scan to contact the car owner", w / 2f, top + qr.height + bottom * 0.55f, paint)
    return out
}

/** Saves a PNG in Pictures/QRCar (no permission needed on Android 10+). Returns null if it could not be saved. */
fun saveQrToGallery(ctx: Context, bmp: Bitmap, name: String): Uri? = try {
    val values = ContentValues().apply {
        put(MediaStore.Images.Media.DISPLAY_NAME, "$name.png")
        put(MediaStore.Images.Media.MIME_TYPE, "image/png")
        put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/QRCar")
    }
    ctx.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)?.let { uri ->
        val ok = ctx.contentResolver.openOutputStream(uri)?.use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
        if (ok == true) uri else null
    }
} catch (e: Exception) {
    null
}

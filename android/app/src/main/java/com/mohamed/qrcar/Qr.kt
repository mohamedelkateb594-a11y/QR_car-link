package com.mohamed.qrcar

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
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

/** Saves the QR as a PNG in Pictures/QRCar (no permission needed on Android 10+). */
fun saveQrToGallery(ctx: Context, bmp: Bitmap, name: String): Boolean {
    val values = ContentValues().apply {
        put(MediaStore.Images.Media.DISPLAY_NAME, "$name.png")
        put(MediaStore.Images.Media.MIME_TYPE, "image/png")
        put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/QRCar")
    }
    val uri = ctx.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return false
    ctx.contentResolver.openOutputStream(uri)?.use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) } ?: return false
    return true
}

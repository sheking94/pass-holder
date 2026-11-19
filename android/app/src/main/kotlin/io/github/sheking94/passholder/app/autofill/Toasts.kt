package io.github.sheking94.passholder.app.autofill

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.widget.Toast

/** A short Toast from any thread (the autofill work runs off the main thread); shown with the application context. */
internal fun Context.showToast(text: String) {
    val context = applicationContext
    Handler(Looper.getMainLooper()).post { Toast.makeText(context, text, Toast.LENGTH_SHORT).show() }
}

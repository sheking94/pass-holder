package io.github.sheking94.passholder.app.autofill

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Parcelable

// The typed getters (with a Class argument) exist only from API 33; older phones need the deprecated ones.

internal inline fun <reified T : Parcelable> Intent.parcelable(name: String): T? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        getParcelableExtra(name, T::class.java)
    } else {
        @Suppress("DEPRECATION")
        (getParcelableExtra(name) as? T)
    }

internal inline fun <reified T : Parcelable> Bundle.parcelable(key: String): T? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        getParcelable(key, T::class.java)
    } else {
        @Suppress("DEPRECATION")
        (getParcelable<Parcelable>(key) as? T)
    }

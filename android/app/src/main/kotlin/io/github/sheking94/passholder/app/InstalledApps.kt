package io.github.sheking94.passholder.app

import android.content.Context
import android.content.Intent

data class InstalledApp(val label: String, val packageName: String)

/** The apps a login can be tied to. Slow (PackageManager), so call it off the main thread. */
fun interface InstalledApps {
    fun list(): List<InstalledApp>
}

/** Launcher apps only (the manifest's <queries> allows exactly that; no QUERY_ALL_PACKAGES). */
class SystemInstalledApps(private val context: Context) : InstalledApps {
    override fun list(): List<InstalledApp> {
        val pm = context.packageManager
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        return pm.queryIntentActivities(intent, 0)
            .map { InstalledApp(it.loadLabel(pm).toString(), it.activityInfo.packageName) }
            .filter { it.packageName != context.packageName }
            .distinctBy { it.packageName }
            .sortedBy { it.label.lowercase() }
    }
}

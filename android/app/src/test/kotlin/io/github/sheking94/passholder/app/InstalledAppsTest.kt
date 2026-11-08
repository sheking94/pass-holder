package io.github.sheking94.passholder.app

import android.content.Intent
import android.content.pm.ResolveInfo
import android.content.pm.ActivityInfo
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(sdk = [35])
class InstalledAppsTest {
    @Test
    fun `launcher apps sorted by label, without the app itself`() {
        val app = ApplicationProvider.getApplicationContext<PassHolderApp>()
        val pm = shadowOf(app.packageManager)
        fun launcher(label: String, pkg: String) {
            val appInfo = ApplicationInfo().apply { packageName = pkg; nonLocalizedLabel = label }
            val activity = ActivityInfo().apply {
                packageName = pkg
                name = "$pkg.Main"
                nonLocalizedLabel = label
                applicationInfo = appInfo
            }
            pm.installPackage(PackageInfo().apply { packageName = pkg; applicationInfo = appInfo; activities = arrayOf(activity) })
            pm.addResolveInfoForIntent(
                Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER),
                ResolveInfo().apply { activityInfo = activity },
            )
        }
        launcher("Bank", "pl.bank")
        launcher("alfa", "com.alfa")
        launcher("PassHolder", app.packageName)
        assertEquals(
            listOf(InstalledApp("alfa", "com.alfa"), InstalledApp("Bank", "pl.bank")),
            SystemInstalledApps(app).list(),
        )
    }
}


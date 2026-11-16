package io.github.sheking94.passholder.app.autofill

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.service.autofill.AutofillService
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.sheking94.passholder.app.PassHolderApp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(sdk = [35])
class ManifestTest {
    @Test
    fun `autofill service is registered behind the bind permission`() {
        val app = ApplicationProvider.getApplicationContext<PassHolderApp>()
        val services = app.packageManager.queryIntentServices(
            Intent(AutofillService.SERVICE_INTERFACE).setPackage(app.packageName),
            PackageManager.GET_META_DATA,
        )
        val service = services.single().serviceInfo
        assertEquals(PassHolderAutofillService::class.java.name, service.name)
        assertEquals(Manifest.permission.BIND_AUTOFILL_SERVICE, service.permission)
        assertEquals(true, service.exported)
        assertEquals(true, service.metaData?.containsKey(AutofillService.SERVICE_META_DATA))

        val unlock = app.packageManager.getActivityInfo(
            android.content.ComponentName(app, AutofillUnlockActivity::class.java),
            0,
        )
        assertFalse(unlock.exported)
        val save = app.packageManager.getActivityInfo(
            android.content.ComponentName(app, AutofillSaveActivity::class.java),
            0,
        )
        assertFalse(save.exported)
    }
}

package io.github.sheking94.passholder.app

import android.content.pm.ApplicationInfo
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.xmlpull.v1.XmlPullParser

/**
 * The phone's vault, identity and paired devices (files/p2p/) must never leave the phone in a backup or a
 * device-to-device transfer: a copy restored elsewhere would be a second "phone" with the same identity.
 */
@RunWith(AndroidJUnit4::class)
// The same Robolectric setup as the screen tests, so no other Android jar has to be downloaded.
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class BackupRulesTest {
    @Test
    fun `backups are off and the extraction rules exclude files`() {
        val app = ApplicationProvider.getApplicationContext<PassHolderApp>()
        val info = app.packageManager.getApplicationInfo(app.packageName, 0)
        assertEquals("allowBackup must be false", 0, info.flags and ApplicationInfo.FLAG_ALLOW_BACKUP)

        // section (cloud-backup / device-transfer) -> excluded domains
        val excluded = mutableMapOf<String, MutableSet<String>>()
        val parser = app.resources.getXml(R.xml.data_extraction_rules)
        var section: String? = null
        while (parser.next() != XmlPullParser.END_DOCUMENT) {
            if (parser.eventType != XmlPullParser.START_TAG) continue
            when (parser.name) {
                "cloud-backup", "device-transfer" -> section = parser.name
                "exclude" -> excluded.getOrPut(section!!) { mutableSetOf() } += parser.getAttributeValue(null, "domain")
            }
        }
        assertTrue("cloud-backup must exclude file: $excluded", "file" in excluded["cloud-backup"].orEmpty())
        assertTrue("device-transfer must exclude file: $excluded", "file" in excluded["device-transfer"].orEmpty())
    }
}

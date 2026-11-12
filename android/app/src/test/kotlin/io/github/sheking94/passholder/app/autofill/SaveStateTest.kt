package io.github.sheking94.passholder.app.autofill

import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.sheking94.passholder.core.autofill.AppRequest
import io.github.sheking94.passholder.core.save.SaveFields
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(sdk = [28])
class SaveStateTest {
    @Test
    fun `client state round trip works below API 33`() {
        val app = AppRequest("com.android.chrome", "github.com", "https")
        val back = SaveSpec(SaveFields(autofillId(2), autofillId(1)), app).toClientState().saveSpecIds()!!
        assertEquals(autofillId(2), back.password)
        assertEquals(autofillId(1), back.username)
        assertEquals(app, back.app)
        assertNull(SaveSpec(SaveFields(autofillId(2), null), app).toClientState().saveSpecIds()!!.username)
    }
}

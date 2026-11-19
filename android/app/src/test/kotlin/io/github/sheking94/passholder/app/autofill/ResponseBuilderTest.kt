package io.github.sheking94.passholder.app.autofill

import android.app.PendingIntent
import android.content.Intent
import android.util.Size
import android.view.autofill.AutofillId
import android.view.inputmethod.InlineSuggestionsRequest
import android.widget.inline.InlinePresentationSpec
import androidx.autofill.inline.UiVersions
import androidx.autofill.inline.v1.InlineSuggestionUi
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.sheking94.passholder.app.PassHolderApp
import io.github.sheking94.passholder.core.autofill.AppRequest
import io.github.sheking94.passholder.core.autofill.DatasetSpec
import io.github.sheking94.passholder.core.autofill.NodeValue
import io.github.sheking94.passholder.core.save.SaveFields
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import org.robolectric.util.ReflectionHelpers.ClassParameter

internal fun autofillId(n: Int): AutofillId =
    ReflectionHelpers.callConstructor(AutofillId::class.java, ClassParameter.from(Int::class.javaPrimitiveType, n))

private fun spec(n: Int) = DatasetSpec(
    "e$n",
    "Wpis $n",
    if (n % 2 == 0) "jan$n" else "",
    listOf(autofillId(1) to NodeValue.Text("jan$n"), autofillId(2) to NodeValue.ListIndex(n)),
)

@RunWith(AndroidJUnit4::class)
@Config(sdk = [35])
class ResponseBuilderTest {
    private val app = ApplicationProvider.getApplicationContext<PassHolderApp>()

    private fun auth() =
        PendingIntent.getActivity(app, 0, Intent(app, AutofillUnlockActivity::class.java), PendingIntent.FLAG_IMMUTABLE).intentSender

    @Test
    fun `no specs give no response`() {
        assertNull(ResponseBuilder(app, null).datasets(emptyList(), null))
    }

    @Test
    fun `no specs with save spec still give a response`() {
        val save = SaveSpec(SaveFields(autofillId(2), null), AppRequest("com.x", null, null))
        assertNotNull(ResponseBuilder(app, null).datasets(emptyList(), save))
    }

    @Test
    fun `two specs give a response`() {
        assertNotNull(ResponseBuilder(app, null).datasets(listOf(spec(0), spec(1)), null))
    }

    @Test
    fun `locked vault gives an unlock prompt`() {
        assertNotNull(ResponseBuilder(app, null).locked(listOf(autofillId(1), autofillId(2)), auth(), null))
    }
}

@RunWith(AndroidJUnit4::class)
@Config(sdk = [30])
class ResponseBuilderInlineTest {
    private val app = ApplicationProvider.getApplicationContext<PassHolderApp>()

    private fun request(styled: Boolean, max: Int = 3): InlineSuggestionsRequest {
        val spec = InlinePresentationSpec.Builder(Size(100, 40), Size(400, 80)).apply {
            if (styled) setStyle(UiVersions.newStylesBuilder().addStyle(InlineSuggestionUi.newStyleBuilder().build()).build())
        }.build()
        return InlineSuggestionsRequest.Builder(listOf(spec)).setMaxSuggestionCount(max).build()
    }

    @Test
    fun `keyboard strip gets at most maxSuggestionCount suggestions`() {
        val inline = request(styled = true)
        for (i in 0..2) assertNotNull("index $i", ResponseBuilder(app, inline).inlinePresentation(i, "Wpis", "jan"))
        assertNull(ResponseBuilder(app, inline).inlinePresentation(3, "Wpis", "jan"))
        assertNotNull(ResponseBuilder(app, inline).datasets((0 until 5).map(::spec), null))
        val auth = PendingIntent.getActivity(app, 0, Intent(app, AutofillUnlockActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        assertNotNull(ResponseBuilder(app, inline).locked(listOf(autofillId(1)), auth.intentSender, null))
    }

    @Test
    fun `never more than ten in the strip`() {
        val inline = request(styled = true, max = 50)
        assertNotNull(ResponseBuilder(app, inline).inlinePresentation(9, "Wpis", null))
        assertNull(ResponseBuilder(app, inline).inlinePresentation(10, "Wpis", null))
    }

    @Test
    fun `spec without a style gives no inline suggestion`() {
        val inline = request(styled = false)
        assertNull(ResponseBuilder(app, inline).inlinePresentation(0, "Wpis", "jan"))
        assertNotNull(ResponseBuilder(app, inline).datasets(listOf(spec(0)), null))
    }
}

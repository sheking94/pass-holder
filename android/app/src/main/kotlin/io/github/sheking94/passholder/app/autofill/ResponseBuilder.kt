package io.github.sheking94.passholder.app.autofill

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.IntentSender
import android.os.Build
import android.service.autofill.Dataset
import android.service.autofill.FillResponse
import android.service.autofill.InlinePresentation
import android.service.autofill.SaveInfo
import android.view.View
import android.view.autofill.AutofillId
import android.view.autofill.AutofillValue
import android.view.inputmethod.InlineSuggestionsRequest
import android.widget.RemoteViews
import androidx.autofill.inline.UiVersions
import androidx.autofill.inline.v1.InlineSuggestionUi
import io.github.sheking94.passholder.app.MainActivity
import io.github.sheking94.passholder.app.R
import io.github.sheking94.passholder.app.UiTexts
import io.github.sheking94.passholder.core.autofill.DatasetSpec
import io.github.sheking94.passholder.core.autofill.NodeValue

/** Only the save request: for a screen with a password field but nothing to fill. */
fun saveOnlyResponse(save: SaveSpec): FillResponse = FillResponse.Builder().withSave(save).build()

/** Asks the system to offer a save once the login screen goes away; [SaveSpec] rides along as client state. */
private fun FillResponse.Builder.withSave(save: SaveSpec?): FillResponse.Builder {
    if (save == null) return this
    val info = SaveInfo.Builder(
        SaveInfo.SAVE_DATA_TYPE_PASSWORD or SaveInfo.SAVE_DATA_TYPE_USERNAME,
        arrayOf(save.fields.password),
    )
    save.fields.username?.let { info.setOptionalIds(arrayOf(it)) }
    info.setFlags(SaveInfo.FLAG_SAVE_ON_ALL_VIEWS_INVISIBLE)
    setSaveInfo(info.build())
    setClientState(save.toClientState())
    return this
}

/**
 * Turns planned datasets into a [FillResponse]: a dropdown row each, plus a keyboard suggestion on API 30+ when the
 * keyboard sent [inline] (its request for suggestions in its strip).
 */
class ResponseBuilder(private val context: Context, private val inline: InlineSuggestionsRequest?) {
    /** Null only when there is nothing to offer: no datasets and no [save]. */
    fun datasets(specs: List<DatasetSpec<AutofillId>>, save: SaveSpec?): FillResponse? {
        if (specs.isEmpty() && save == null) return null
        val response = FillResponse.Builder()
        specs.forEachIndexed { index, spec -> response.addDataset(dataset(index, spec)) }
        return response.withSave(save).build()
    }

    /** One "Odblokuj PassHolder" suggestion over [ids]; choosing it starts [auth]. */
    fun locked(ids: List<AutofillId>, auth: IntentSender, save: SaveSpec?): FillResponse {
        val presentation = presentation(UiTexts.UNLOCK_TITLE, null)
        val response = FillResponse.Builder()
        val inlinePresentation = inlinePresentation(0, UiTexts.UNLOCK_TITLE, null)
        // The SDK check again only for the API 30 overload: inlinePresentation is null below API 30 anyway.
        if (inlinePresentation != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            @Suppress("DEPRECATION")
            response.setAuthentication(ids.toTypedArray(), auth, presentation, inlinePresentation)
        } else {
            @Suppress("DEPRECATION")
            response.setAuthentication(ids.toTypedArray(), auth, presentation)
        }
        return response.withSave(save).build()
    }

    /**
     * The keyboard suggestion number [index], or null below API 30, without [inline], when the keyboard takes no
     * more suggestions or its style spec does not support [UiVersions.INLINE_UI_VERSION_1]. Specs beyond the list
     * reuse the last one.
     */
    fun inlinePresentation(index: Int, title: String, subtitle: String?): InlinePresentation? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        val request = inline ?: return null
        if (index >= minOf(MAX_INLINE, request.maxSuggestionCount)) return null
        val specs = request.inlinePresentationSpecs
        if (specs.isEmpty()) return null
        val spec = specs[minOf(index, specs.size - 1)]
        if (UiVersions.INLINE_UI_VERSION_1 !in UiVersions.getVersions(spec.style)) return null
        // A long press on the suggestion opens the app.
        val attribution = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val content = InlineSuggestionUi.newContentBuilder(attribution)
            .setTitle(title)
            .setContentDescription(title)
        if (!subtitle.isNullOrEmpty()) content.setSubtitle(subtitle)
        return InlinePresentation(content.build().slice, spec, false)
    }

    private fun dataset(index: Int, spec: DatasetSpec<AutofillId>): Dataset {
        // Deprecated in API 33 (Presentations), but the only form that works from API 26.
        @Suppress("DEPRECATION")
        val dataset = Dataset.Builder(presentation(spec.title, spec.subtitle))
        for ((id, value) in spec.values) {
            @Suppress("DEPRECATION")
            dataset.setValue(id, autofillValue(value))
        }
        // Non-null only on API 30+, where setInlinePresentation exists.
        inlinePresentation(index, spec.title, spec.subtitle)?.let {
            @Suppress("DEPRECATION", "NewApi")
            dataset.setInlinePresentation(it)
        }
        return dataset.build()
    }

    private fun autofillValue(value: NodeValue): AutofillValue = when (value) {
        is NodeValue.Text -> AutofillValue.forText(value.value)
        is NodeValue.ListIndex -> AutofillValue.forList(value.index)
    }

    private fun presentation(title: String, subtitle: String?): RemoteViews =
        RemoteViews(context.packageName, R.layout.autofill_item).apply {
            setTextViewText(R.id.title, title)
            if (subtitle.isNullOrEmpty()) {
                setViewVisibility(R.id.subtitle, View.GONE)
            } else {
                setTextViewText(R.id.subtitle, subtitle)
            }
        }

    private companion object {
        /** The keyboard strip never shows more than this, whatever the keyboard allows. */
        const val MAX_INLINE = 10
    }
}

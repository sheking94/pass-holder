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
import androidx.annotation.RequiresApi
import androidx.autofill.inline.UiVersions
import androidx.autofill.inline.v1.InlineSuggestionUi
import io.github.sheking94.passholder.app.MainActivity
import io.github.sheking94.passholder.app.R
import io.github.sheking94.passholder.core.autofill.DatasetSpec
import io.github.sheking94.passholder.core.autofill.NodeValue

/** Turns planned datasets into a [FillResponse]: a dropdown row each, plus a keyboard suggestion on API 30+. */
object ResponseBuilder {
    /** The keyboard strip never shows more than this, whatever the keyboard allows. */
    private const val MAX_INLINE = 10
    const val UNLOCK_TITLE = "Odblokuj PassHolder"

    /** Null only when there is nothing to offer: no datasets and no [save]. */
    fun datasets(
        context: Context,
        specs: List<DatasetSpec<AutofillId>>,
        inline: InlineSuggestionsRequest?,
        save: SaveSpec?,
    ): FillResponse? {
        if (specs.isEmpty() && save == null) return null
        val response = FillResponse.Builder()
        specs.forEachIndexed { index, spec ->
            // Deprecated in API 33 (Presentations), but the only form that works from API 26.
            @Suppress("DEPRECATION")
            val dataset = Dataset.Builder(presentation(context, spec.title, spec.subtitle))
            for ((id, value) in spec.values) {
                @Suppress("DEPRECATION")
                dataset.setValue(
                    id,
                    when (value) {
                        is NodeValue.Text -> AutofillValue.forText(value.value)
                        is NodeValue.ListIndex -> AutofillValue.forList(value.index)
                    },
                )
            }
            if (inline != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                inlinePresentation(context, inline, index, spec.title, spec.subtitle)?.let {
                    @Suppress("DEPRECATION")
                    dataset.setInlinePresentation(it)
                }
            }
            response.addDataset(dataset.build())
        }
        withSave(response, save)
        return response.build()
    }

    /** One "Odblokuj PassHolder" suggestion over [ids]; choosing it starts [auth]. */
    fun locked(context: Context, ids: List<AutofillId>, auth: IntentSender, inline: InlineSuggestionsRequest?, save: SaveSpec?): FillResponse {
        val presentation = presentation(context, UNLOCK_TITLE, null)
        val response = FillResponse.Builder()
        val inlinePresentation = if (inline != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            inlinePresentation(context, inline, 0, UNLOCK_TITLE, null)
        } else {
            null
        }
        if (inlinePresentation != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            @Suppress("DEPRECATION")
            response.setAuthentication(ids.toTypedArray(), auth, presentation, inlinePresentation)
        } else {
            @Suppress("DEPRECATION")
            response.setAuthentication(ids.toTypedArray(), auth, presentation)
        }
        withSave(response, save)
        return response.build()
    }

    /** Asks the system to offer a save once the login screen goes away; [SaveSpec] rides along as client state. */
    private fun withSave(response: FillResponse.Builder, save: SaveSpec?) {
        if (save == null) return
        val info = SaveInfo.Builder(
            SaveInfo.SAVE_DATA_TYPE_PASSWORD or SaveInfo.SAVE_DATA_TYPE_USERNAME,
            arrayOf(save.fields.password),
        )
        save.fields.username?.let { info.setOptionalIds(arrayOf(it)) }
        info.setFlags(SaveInfo.FLAG_SAVE_ON_ALL_VIEWS_INVISIBLE)
        response.setSaveInfo(info.build())
        response.setClientState(save.toClientState())
    }

    /**
     * The keyboard suggestion number [index], or null when the keyboard takes no more suggestions or its style
     * spec does not support [UiVersions.INLINE_UI_VERSION_1]. Specs beyond the list reuse the last one.
     */
    @RequiresApi(Build.VERSION_CODES.R)
    fun inlinePresentation(
        context: Context,
        inline: InlineSuggestionsRequest,
        index: Int,
        title: String,
        subtitle: String?,
    ): InlinePresentation? {
        if (index >= minOf(MAX_INLINE, inline.maxSuggestionCount)) return null
        val specs = inline.inlinePresentationSpecs
        if (specs.isEmpty()) return null
        val spec = specs[minOf(index, specs.size - 1)]
        if (UiVersions.INLINE_UI_VERSION_1 !in UiVersions.getVersions(spec.style)) return null
        // A long press on the suggestion opens the app.
        val attribution = PendingIntent.getActivity(
            context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val content = InlineSuggestionUi.newContentBuilder(attribution)
            .setTitle(title)
            .setContentDescription(title)
        if (!subtitle.isNullOrEmpty()) content.setSubtitle(subtitle)
        return InlinePresentation(content.build().slice, spec, false)
    }

    private fun presentation(context: Context, title: String, subtitle: String?): RemoteViews =
        RemoteViews(context.packageName, R.layout.autofill_item).apply {
            setTextViewText(R.id.title, title)
            if (subtitle.isNullOrEmpty()) {
                setViewVisibility(R.id.subtitle, View.GONE)
            } else {
                setTextViewText(R.id.subtitle, subtitle)
            }
        }
}

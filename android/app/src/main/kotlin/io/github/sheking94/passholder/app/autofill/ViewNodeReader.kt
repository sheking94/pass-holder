package io.github.sheking94.passholder.app.autofill

import android.app.assist.AssistStructure
import android.os.Build
import android.text.InputType
import android.view.View
import android.view.autofill.AutofillId
import io.github.sheking94.passholder.core.autofill.AppRequest
import io.github.sheking94.passholder.core.autofill.AutofillNode
import io.github.sheking94.passholder.core.autofill.FieldDescriptor
import io.github.sheking94.passholder.core.autofill.FieldOption

/** Plain attributes of a view node, so the mapping to [FieldDescriptor] is testable without Android objects. */
data class NodeAttrs(
    val hints: List<String>,
    val htmlTag: String?,
    val htmlAttrs: Map<String, String>,
    val inputType: Int,
    val idEntry: String?,
    val hint: String?,
    val contentDescription: String?,
    val maxTextLength: Int,
    val options: List<String>?,
    val isList: Boolean,
)

private val WHITESPACE = Regex("\\s+")

private fun nativeType(inputType: Int): String {
    val variation = inputType and InputType.TYPE_MASK_VARIATION
    return when (inputType and InputType.TYPE_MASK_CLASS) {
        InputType.TYPE_CLASS_TEXT -> when (variation) {
            InputType.TYPE_TEXT_VARIATION_PASSWORD,
            InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD,
            InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD -> "password"
            InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS,
            InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS -> "email"
            else -> "text"
        }
        InputType.TYPE_CLASS_NUMBER ->
            if (variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD) "password" else "text"
        InputType.TYPE_CLASS_PHONE -> "tel"
        else -> "text"
    }
}

fun describeNode(a: NodeAttrs): FieldDescriptor {
    val tokens = a.htmlAttrs["autocomplete"].orEmpty().trim().split(WHITESPACE).filter { it.isNotEmpty() }
    val type = when {
        a.htmlTag.equals("select", ignoreCase = true) -> "select"
        a.htmlAttrs["type"] != null -> a.htmlAttrs.getValue("type")
        a.htmlTag != null -> "text"
        else -> nativeType(a.inputType)
    }
    return FieldDescriptor(
        autocomplete = tokens + a.hints,
        type = type,
        name = a.htmlAttrs["name"] ?: a.idEntry.orEmpty(),
        id = a.htmlAttrs["id"] ?: a.idEntry.orEmpty(),
        label = a.htmlAttrs["label"] ?: a.contentDescription.orEmpty(),
        placeholder = a.htmlAttrs["placeholder"] ?: a.hint.orEmpty(),
        maxLength = a.htmlAttrs["maxlength"]?.toIntOrNull() ?: a.maxTextLength.takeIf { it > 0 },
        options = a.options?.map { FieldOption(it, it) },
    )
}

class ParsedRequest(val app: AppRequest, val nodes: List<AutofillNode<AutofillId>>)

/** Reads fillable fields of the last window of [structure]; Android-only, verified on a device. */
fun readRequest(structure: AssistStructure): ParsedRequest {
    val nodes = mutableListOf<AutofillNode<AutofillId>>()
    var webDomain: String? = null
    var webScheme: String? = null
    var packageName = ""
    val count = structure.windowNodeCount
    if (count > 0) {
        packageName = structure.activityComponent?.packageName.orEmpty()

        fun visit(node: AssistStructure.ViewNode) {
            if (webDomain == null) webDomain = node.webDomain?.takeIf { it.isNotEmpty() }
            if (webScheme == null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                webScheme = node.webScheme?.takeIf { it.isNotEmpty() }
            }
            val id = node.autofillId
            val type = node.autofillType
            if (id != null && (type == View.AUTOFILL_TYPE_TEXT || type == View.AUTOFILL_TYPE_LIST) &&
                node.visibility == View.VISIBLE && node.isEnabled
            ) {
                val html = node.htmlInfo
                val attrs = HashMap<String, String>()
                html?.attributes?.forEach { attrs[it.first.lowercase()] = it.second }
                val isList = type == View.AUTOFILL_TYPE_LIST
                val na = NodeAttrs(
                    hints = node.autofillHints?.toList().orEmpty(),
                    htmlTag = html?.tag,
                    htmlAttrs = attrs,
                    inputType = node.inputType,
                    idEntry = node.idEntry,
                    hint = node.hint,
                    contentDescription = node.contentDescription?.toString(),
                    maxTextLength = node.maxTextLength,
                    options = node.autofillOptions?.map { it.toString() },
                    isList = isList,
                )
                nodes += AutofillNode(id, describeNode(na), isList)
            }
            for (i in 0 until node.childCount) visit(node.getChildAt(i))
        }
        visit(structure.getWindowNodeAt(count - 1).rootViewNode)
    }
    return ParsedRequest(AppRequest(packageName, webDomain, webScheme), nodes)
}

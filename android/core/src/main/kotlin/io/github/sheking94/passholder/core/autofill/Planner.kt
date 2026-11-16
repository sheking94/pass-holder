package io.github.sheking94.passholder.core.autofill

import io.github.sheking94.passholder.core.p2p.CardFields
import io.github.sheking94.passholder.core.p2p.ContactFields
import io.github.sheking94.passholder.core.p2p.LoginFields
import io.github.sheking94.passholder.core.p2p.PhoneEntry

/** A fillable field of the screen; [isList] marks a choice field whose value is an option index. */
data class AutofillNode<Id>(val id: Id, val field: FieldDescriptor, val isList: Boolean)

sealed interface NodeValue {
    data class Text(val value: String) : NodeValue
    data class ListIndex(val index: Int) : NodeValue
}

enum class FillGroup { LOGIN, CARD, CONTACT }

data class DatasetSpec<Id>(val entryId: String, val title: String, val subtitle: String, val values: List<Pair<Id, NodeValue>>)

/** The fields of one group with their kinds. */
data class FillRequestPlan<Id>(val group: FillGroup, val nodes: List<Pair<AutofillNode<Id>, FieldKind>>)

private const val MAX_DATASETS = 10

private val CARD_KINDS = setOf(
    FieldKind.CC_NAME,
    FieldKind.CC_NUMBER,
    FieldKind.CC_EXP,
    FieldKind.CC_EXP_MONTH,
    FieldKind.CC_EXP_YEAR,
    FieldKind.CC_CSC,
)

fun <Id> planRequest(nodes: List<AutofillNode<Id>>): FillRequestPlan<Id>? {
    val classified = nodes.mapNotNull { n -> classifyField(n.field)?.let { n to it } }
    val kinds = classified.map { it.second }.toSet()
    val group = when {
        FieldKind.USERNAME in kinds || FieldKind.PASSWORD in kinds -> FillGroup.LOGIN

        kinds.any { it in CARD_KINDS } -> FillGroup.CARD

        kinds.any { it != FieldKind.EMAIL && it != FieldKind.NEW_PASSWORD } -> FillGroup.CONTACT

        FieldKind.EMAIL in kinds -> FillGroup.LOGIN

        // a lone e-mail field is the first step of a login
        else -> return null
    }
    val inGroup = classified.filter { (_, kind) ->
        when (group) {
            FillGroup.LOGIN -> kind == FieldKind.USERNAME || kind == FieldKind.PASSWORD || kind == FieldKind.EMAIL

            FillGroup.CARD -> kind in CARD_KINDS

            FillGroup.CONTACT ->
                kind !in CARD_KINDS && kind != FieldKind.USERNAME &&
                    kind != FieldKind.PASSWORD && kind != FieldKind.NEW_PASSWORD
        }
    }
    return FillRequestPlan(group, inGroup)
}

private fun cardAllowed(request: AppRequest): Boolean {
    // A browser page without a reported scheme counts as http (review V3-N5).
    val plainBrowser = request.browserVerified && pageScheme(request) != "https"
    return !plainBrowser || request.webDomain == "localhost"
}

private fun <Id> valuesFor(plan: FillRequestPlan<Id>, entry: PhoneEntry): List<Pair<Id, NodeValue>> {
    val fillPlan = planFor(entry.content) ?: return emptyList()
    val hasUsername = plan.nodes.any { it.second == FieldKind.USERNAME }
    return plan.nodes.mapNotNull { (node, kind) ->
        val value = fillValue(fillPlan, kind, node.field, hasUsername) ?: return@mapNotNull null
        if (node.isList) {
            val index = node.field.options?.indexOfFirst { it.value == value } ?: -1
            if (index < 0) null else node.id to NodeValue.ListIndex(index)
        } else {
            node.id to NodeValue.Text(value)
        }
    }
}

private fun subtitle(entry: PhoneEntry): String = when (val f = entry.content.fields) {
    is LoginFields -> f.username
    is CardFields -> f.number.filter { it in '0'..'9' }.takeLast(4).let { if (it.isEmpty()) "" else "•••• $it" }
    is ContactFields -> listOf(f.firstName, f.lastName).filter { it.isNotEmpty() }.joinToString(" ")
    else -> ""
}

fun <Id> planDatasets(plan: FillRequestPlan<Id>, request: AppRequest, entries: List<PhoneEntry>): List<DatasetSpec<Id>> {
    val candidates: List<PhoneEntry> = when (plan.group) {
        FillGroup.LOGIN -> matchApp(request, entries.filter { it.content.fields is LoginFields }) {
            val f = it.content.fields as LoginFields
            AppCandidate(it.content.name, f.urls, f.androidApps)
        }

        FillGroup.CARD -> if (cardAllowed(request)) entries.filter { it.content.fields is CardFields } else emptyList()

        FillGroup.CONTACT -> entries.filter { it.content.fields is ContactFields }
    }
    return candidates.asSequence()
        .map { it to valuesFor(plan, it) }
        .filter { it.second.isNotEmpty() }
        .take(MAX_DATASETS)
        .map { (e, values) -> DatasetSpec(e.id, e.content.name, subtitle(e), values) }
        .toList()
}

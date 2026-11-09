package io.github.sheking94.passholder.app.ui.forms

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** Stable keys for the rows, so a row's own state (a shown secret) stays with it when a row above is removed. */
private class RowKeys {
    private val keys = ArrayList<Long>()
    private var next = 0L

    fun forSize(size: Int): List<Long> {
        while (keys.size < size) keys.add(next++)
        while (keys.size > size) keys.removeAt(keys.lastIndex)
        return keys
    }

    fun remove(index: Int) {
        keys.removeAt(index)
    }
}

/**
 * An editable list (addresses, apps, phones, custom fields…): [title], a row per item with "Usuń" and
 * "+ [addLabel]", which appends [empty], plus [extraActions] beside it. Empty items are dropped on save (tidyContent), not here.
 */
@Composable
fun <T> ListEditor(
    title: String,
    items: List<T>,
    onChange: (List<T>) -> Unit,
    addLabel: String,
    empty: () -> T,
    extraActions: @Composable () -> Unit = {},
    item: @Composable (T, (T) -> Unit) -> Unit,
) {
    val rowKeys = remember { RowKeys() }
    val keys = rowKeys.forSize(items.size)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.titleSmall)
        items.forEachIndexed { index, value ->
            key(keys[index]) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f)) {
                        item(value) { changed -> onChange(items.toMutableList().also { it[index] = changed }) }
                    }
                    TextButton(onClick = {
                        rowKeys.remove(index)
                        onChange(items.filterIndexed { i, _ -> i != index })
                    }) { Text("Usuń") }
                }
            }
        }
        Row {
            TextButton(onClick = { onChange(items + empty()) }) { Text("+ $addLabel") }
            extraActions()
        }
    }
}

package io.github.sheking94.passholder.app.ui.forms

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.sheking94.passholder.app.AppViewModel
import io.github.sheking94.passholder.app.errorMessage
import io.github.sheking94.passholder.core.CharacterGroup
import io.github.sheking94.passholder.core.GeneratorOptions
import io.github.sheking94.passholder.core.PasswordGenerator
import kotlin.math.roundToInt

private val GROUP_LABELS = mapOf(
    CharacterGroup.LOWERCASE to "małe litery",
    CharacterGroup.UPPERCASE to "wielkie litery",
    CharacterGroup.DIGITS to "cyfry",
    CharacterGroup.SYMBOLS to "symbole",
)

/** "Generator haseł": length and character groups (remembered in the settings once used), "Generuj". */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun GeneratorCard(vm: AppViewModel, onGenerated: (String) -> Unit) {
    val saved = remember { vm.generatorOptions }
    var length by remember { mutableFloatStateOf(saved.length.toFloat()) }
    var groups by remember { mutableStateOf(saved.groups) }

    Card {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("Generator haseł", style = MaterialTheme.typography.titleSmall)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Długość: ${length.roundToInt()}")
                Slider(
                    value = length,
                    onValueChange = { length = it },
                    valueRange = PasswordGenerator.MIN_LENGTH.toFloat()..PasswordGenerator.MAX_LENGTH.toFloat(),
                    modifier = Modifier.padding(start = 12.dp),
                )
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                CharacterGroup.entries.forEach { group ->
                    FilterChip(
                        selected = group in groups,
                        onClick = { groups = if (group in groups) groups - group else groups + group },
                        label = { Text(GROUP_LABELS.getValue(group)) },
                    )
                }
            }
            OutlinedButton(onClick = {
                val options = GeneratorOptions(length.roundToInt(), groups)
                runCatching { PasswordGenerator.generate(options) }
                    .onSuccess {
                        onGenerated(it)
                        vm.generatorOptions = options
                    }
                    .onFailure { vm.fail(errorMessage(it)) }
            }) { Text("Generuj") }
        }
    }
}

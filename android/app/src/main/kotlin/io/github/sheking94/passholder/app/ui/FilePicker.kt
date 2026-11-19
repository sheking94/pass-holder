package io.github.sheking94.passholder.app.ui

import android.content.ActivityNotFoundException
import io.github.sheking94.passholder.app.UiTexts

/**
 * Opens the system file picker with [launch]. The picker is another app, so [FilePicks.beginFilePick] comes first
 * (leaving for it does not lock the vault). A phone without a picker gets [UiTexts.NO_FILE_PICKER] on the status
 * line; [onMissing] lets the caller drop what it prepared for the result.
 */
fun FilePicks.launchPicker(onMissing: () -> Unit = {}, launch: () -> Unit) {
    beginFilePick()
    try {
        launch()
    } catch (_: ActivityNotFoundException) {
        onMissing()
        endFilePick()
        fail(UiTexts.NO_FILE_PICKER)
    }
}

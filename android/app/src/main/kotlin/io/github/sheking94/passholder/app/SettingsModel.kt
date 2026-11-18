package io.github.sheking94.passholder.app

import io.github.sheking94.passholder.app.ui.SettingsActions
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** The plain switches of "Ustawienia", saved in [Settings]. */
internal class SettingsModel(
    private val settings: Settings,
    /** Read on every use: tests replace it. */
    private val autofillStatus: () -> AutofillStatus,
) : SettingsActions {
    private val _lockDelay = MutableStateFlow(settings.lockDelay)
    override val lockDelay: StateFlow<Boolean> = _lockDelay.asStateFlow()

    private val _askToSave = MutableStateFlow(settings.askToSave)
    override val askToSave: StateFlow<Boolean> = _askToSave.asStateFlow()

    override fun setLockDelay(on: Boolean) {
        settings.lockDelay = on
        _lockDelay.value = on
    }

    override fun setAskToSave(on: Boolean) {
        settings.askToSave = on
        _askToSave.value = on
    }

    override fun autofillEnabled(): Boolean = autofillStatus().isEnabled()
}

package io.github.sheking94.passholder.app

import android.content.Context
import android.view.autofill.AutofillManager

/** Whether PassHolder is the phone's autofill service; tests replace it. */
fun interface AutofillStatus {
    fun isEnabled(): Boolean
}

class SystemAutofillStatus(private val context: Context) : AutofillStatus {
    override fun isEnabled(): Boolean = context.getSystemService(AutofillManager::class.java)?.hasEnabledAutofillServices() == true
}

package io.github.sheking94.passholder.app.autofill

import android.os.Bundle
import androidx.fragment.app.FragmentActivity

/** Placeholder for the unlock screen of a locked-vault suggestion; Task 6 replaces it. Gives no result yet. */
class AutofillUnlockActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setResult(RESULT_CANCELED)
        finish()
    }
}

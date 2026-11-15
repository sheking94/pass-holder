package io.github.sheking94.passholder.core.autofill

import io.github.sheking94.passholder.core.p2p.CardFields
import io.github.sheking94.passholder.core.p2p.ContactFields
import io.github.sheking94.passholder.core.p2p.EntryContentV3
import io.github.sheking94.passholder.core.p2p.EntryDataV3
import io.github.sheking94.passholder.core.p2p.Hlc
import io.github.sheking94.passholder.core.p2p.LabeledValue
import io.github.sheking94.passholder.core.p2p.LoginFields
import io.github.sheking94.passholder.core.p2p.PhoneEntry
import io.github.sheking94.passholder.core.p2p.PostalAddress
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue

class PlannerTest {
    private fun entry(id: String, name: String, fields: io.github.sheking94.passholder.core.p2p.EntryFieldsV3) =
        PhoneEntry(id, 1, EntryDataV3(EntryContentV3(name, "", fields, emptyList()), Hlc(1, 0, "d")))

    private fun login(id: String, name: String, user: String, pass: String = "pw", urls: List<String> = emptyList(), apps: List<String> = emptyList()) =
        entry(id, name, LoginFields(user, pass, "", urls, apps))

    private fun card(id: String, name: String, number: String = "4111 1111 1111 1111", expiry: String = "07/29") =
        entry(id, name, CardFields("Jan Kowalski", number, expiry, "123", ""))

    private fun node(id: String, ac: String = "", type: String = "text", isList: Boolean = false, options: List<FieldOption>? = null) =
        AutofillNode(id, FieldDescriptor(autocomplete = listOfNotNull(ac.ifEmpty { null }), type = type, options = options), isList)

    private val browser = TRUSTED_BROWSERS.first()
    private val web = AppRequest(browser, "example.com", "https")

    @Test
    fun `login form gets matching logins with username and password`() {
        val plan = planRequest(listOf(node("u", "username"), node("p", "current-password")))!!
        assertEquals(FillGroup.LOGIN, plan.group)
        val entries = listOf(
            login("1", "Example", "jan", "s3", listOf("https://example.com")),
            login("2", "Other", "x", urls = listOf("https://other.org")),
        )
        val sets = planDatasets(plan, web, entries)
        assertEquals(1, sets.size)
        assertEquals("1", sets[0].entryId)
        assertEquals(listOf("u" to NodeValue.Text("jan"), "p" to NodeValue.Text("s3")), sets[0].values)
    }

    @Test
    fun `email only field is a login step`() {
        val plan = planRequest(listOf(node("e", "email")))!!
        assertEquals(FillGroup.LOGIN, plan.group)
        val sets = planDatasets(plan, web, listOf(login("1", "Example", "jan@x.pl", urls = listOf("https://example.com"))))
        assertEquals(listOf("e" to NodeValue.Text("jan@x.pl")), sets.single().values)
    }

    @Test
    fun `registration form with only new passwords gives no plan`() {
        assertNull(planRequest(listOf(node("a", "new-password"), node("b", "new-password"))))
        assertNull(planRequest(emptyList<AutofillNode<String>>()))
    }

    @Test
    fun `entry without any value is skipped`() {
        val loginPlan = planRequest(listOf(node("u", "username")))!!
        val sets = planDatasets(loginPlan, web, listOf(
            login("1", "A", "", urls = listOf("https://example.com")),
            login("2", "B", "bob", urls = listOf("https://example.com")),
        ))
        assertEquals(listOf("2"), sets.map { it.entryId })

        val cardPlan = planRequest(listOf(node("m", "cc-exp-month"), node("y", "cc-exp-year")))!!
        val cards = planDatasets(cardPlan, web, listOf(card("c1", "Bad", expiry = "7/2029"), card("c2", "Good")))
        assertEquals(listOf("c2"), cards.map { it.entryId })
    }

    @Test
    fun `card fields get cards in list order, not in http browser`() {
        val plan = planRequest(listOf(node("n", "cc-number"), node("u", "username")))!!
        assertEquals(FillGroup.LOGIN, plan.group)
        val cardPlan = planRequest(listOf(node("n", "cc-number"), node("c", "cc-csc")))!!
        assertEquals(FillGroup.CARD, cardPlan.group)
        val entries = listOf(card("2", "Zeta"), login("l", "L", "u"), card("1", "Alfa"))
        val sets = planDatasets(cardPlan, web, entries)
        assertEquals(listOf("2", "1"), sets.map { it.entryId })
        assertEquals(listOf("n" to NodeValue.Text("4111111111111111"), "c" to NodeValue.Text("123")), sets[0].values)

        assertTrue(planDatasets(cardPlan, AppRequest(browser, "shop.pl", "http"), entries).isEmpty())
        // No reported scheme (Android 8.0-8.1) counts as http (review V3-N5).
        assertTrue(planDatasets(cardPlan, AppRequest(browser, "shop.pl", null), entries).isEmpty())
        assertEquals(2, planDatasets(cardPlan, AppRequest(browser, "localhost", "http"), entries).size)
        assertEquals(2, planDatasets(cardPlan, AppRequest("com.shop.app", null, null), entries).size)
    }

    @Test
    fun `contact form fills names, address and first phone`() {
        val fields = listOf(
            node("g", "given-name"), node("f", "family-name"), node("s", "street-address"),
            node("z", "postal-code"), node("c", "address-level2"), node("t", "tel"),
        )
        assertEquals(FillGroup.LOGIN, planRequest(fields + node("p", "current-password"))!!.group) // password wins
        val cp = planRequest(fields)!!
        assertEquals(FillGroup.CONTACT, cp.group)
        val contact = entry("k", "Jan", ContactFields(
            "Jan", "Kowalski", "", listOf(LabeledValue("a", "111"), LabeledValue("b", "222")), emptyList(),
            listOf(PostalAddress("h", "Długa 1", "00-001", "Gdańsk", "Polska")),
        ))
        val sets = planDatasets(cp, web, listOf(contact, login("l", "L", "u")))
        assertEquals(
            listOf("g" to "Jan", "f" to "Kowalski", "s" to "Długa 1", "z" to "00-001", "c" to "Gdańsk", "t" to "111")
                .map { it.first to NodeValue.Text(it.second) },
            sets.single().values,
        )
    }

    @Test
    fun `select field gets the option index`() {
        val opts = listOf(FieldOption("", "Wybierz"), FieldOption("07", "Lipiec"), FieldOption("08", "Sierpień"))
        val plan = planRequest(listOf(node("m", "cc-exp-month", type = "select", isList = true, options = opts)))!!
        val sets = planDatasets(plan, web, listOf(card("c", "K")))
        assertEquals(listOf("m" to NodeValue.ListIndex(1)), sets.single().values)

        val none = listOf(FieldOption("01", "Styczeń"))
        val plan2 = planRequest(listOf(node("m", "cc-exp-month", type = "select", isList = true, options = none)))!!
        assertTrue(planDatasets(plan2, web, listOf(card("c", "K"))).isEmpty())
    }

    @Test
    fun `at most ten datasets`() {
        val plan = planRequest(listOf(node("u", "username")))!!
        val entries = (1..15).map { login("$it", "L%02d".format(it), "u$it", urls = listOf("https://example.com")) }
        assertEquals(10, planDatasets(plan, web, entries).size)
    }

    @Test
    fun `subtitle per type`() {
        val lp = planRequest(listOf(node("u", "username")))!!
        assertEquals("jan", planDatasets(lp, web, listOf(login("1", "A", "jan", urls = listOf("https://example.com")))).single().subtitle)
        assertEquals("A", planDatasets(lp, web, listOf(login("1", "A", "jan", urls = listOf("https://example.com")))).single().title)
        val cp = planRequest(listOf(node("n", "cc-number")))!!
        assertEquals("•••• 1111", planDatasets(cp, web, listOf(card("c", "K"))).single().subtitle)
        assertEquals("", planDatasets(cp, web, listOf(card("c", "K", number = "abc"))).let { it.singleOrNull()?.subtitle ?: "" })
        val kp = planRequest(listOf(node("g", "given-name")))!!
        val contact = entry("k", "Jan", ContactFields("Jan", "Kowalski", "", emptyList(), emptyList(), emptyList()))
        assertEquals("Jan Kowalski", planDatasets(kp, web, listOf(contact)).single().subtitle)
        
    }
}

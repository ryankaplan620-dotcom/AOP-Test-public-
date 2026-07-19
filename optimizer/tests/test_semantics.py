"""
AOP :: optimizer/tests/test_semantics.py
========================================

Unit tests for the regex + semantic-heuristic parser (semantics.py) — the
extraction stage of the AOP policy-scoring pipeline.  Covers every pattern
family the parser contract lists: return windows (incl. final-sale and
unspecified), shipping speeds (incl. business-day conversion and the
ambiguity default), free-shipping classification, every hidden-penalty
term, and the never-raise guarantee on arbitrary input.
"""

import unittest

from aop_optimizer.semantics import (
    DEFAULT_SHIPPING_DAYS,
    PolicyMetrics,
    parse_policy_semantics,
)


class ReturnWindowTests(unittest.TestCase):
    """Return-window phrasings, final-sale, and the unspecified default."""

    def test_hyphenated_day_returns(self):
        m = parse_policy_semantics("We offer 30-day returns on all items.")
        self.assertEqual(m.return_window_days, 30)
        self.assertFalse(m.final_sale)
        self.assertFalse(m.returns_unspecified)
        self.assertIn("30-day returns", m.return_evidence)

    def test_returns_within_days_of_delivery(self):
        m = parse_policy_semantics("Returns within 14 days of delivery.")
        self.assertEqual(m.return_window_days, 14)
        self.assertIn("14 days", m.return_evidence)

    def test_return_policy_colon_days(self):
        m = parse_policy_semantics("Return policy: 60 days.")
        self.assertEqual(m.return_window_days, 60)

    def test_days_to_return(self):
        m = parse_policy_semantics("You have 45 days to return your purchase.")
        self.assertEqual(m.return_window_days, 45)

    def test_may_be_returned_within(self):
        m = parse_policy_semantics("Items may be returned within 21 days.")
        self.assertEqual(m.return_window_days, 21)

    def test_no_returns_is_final_sale_zero_window(self):
        m = parse_policy_semantics("No returns.")
        self.assertEqual(m.return_window_days, 0)
        self.assertTrue(m.final_sale)
        self.assertFalse(m.returns_unspecified)

    def test_all_sales_final(self):
        m = parse_policy_semantics("ALL SALES ARE FINAL!")
        self.assertEqual(m.return_window_days, 0)
        self.assertTrue(m.final_sale)

    def test_no_returns_after_n_days_is_a_window_not_final_sale(self):
        # "no returns after 30 days" bounds a window; it must NOT be read as
        # a store-wide refusal.
        m = parse_policy_semantics("No returns after 30 days.")
        self.assertEqual(m.return_window_days, 30)
        self.assertFalse(m.final_sale)

    def test_absent_returns_is_unspecified_not_zero(self):
        m = parse_policy_semantics("Fast shipping. Great prices.")
        self.assertIsNone(m.return_window_days)
        self.assertTrue(m.returns_unspecified)
        self.assertFalse(m.final_sale)

    def test_numeric_window_beats_category_final_sale_mention(self):
        m = parse_policy_semantics(
            "30-day returns. Clearance items are final sale."
        )
        self.assertEqual(m.return_window_days, 30)
        self.assertFalse(m.final_sale)
        # The category carve-out surfaces as a hidden penalty instead.
        codes = {t.code for t in m.hidden_penalties}
        self.assertIn("final_sale_category", codes)


class ShippingSpeedTests(unittest.TestCase):
    """Shipping phrasings, business-day conversion, ambiguity default."""

    def test_business_day_range_takes_worst_case_and_converts(self):
        m = parse_policy_semantics("Ships in 4-6 business days.")
        # Worst case 6 business days -> ceil(6 * 7/5) = 9 calendar days.
        self.assertEqual(m.shipping_days, 9)
        self.assertEqual(m.shipping_business_days, 6)
        self.assertTrue(m.business_day_conversion_applied)
        self.assertFalse(m.ambiguous_shipping)
        self.assertIn("4-6 business days", m.shipping_evidence)

    def test_delivery_within_days(self):
        m = parse_policy_semantics("Delivery within 2 days, guaranteed.")
        self.assertEqual(m.shipping_days, 2)
        self.assertFalse(m.business_day_conversion_applied)
        self.assertIsNone(m.shipping_business_days)

    def test_n_day_shipping(self):
        m = parse_policy_semantics("Enjoy 2-day shipping on every order.")
        self.assertEqual(m.shipping_days, 2)

    def test_n_business_day_shipping_converts(self):
        m = parse_policy_semantics("3 business day delivery.")
        # ceil(3 * 7/5) = ceil(4.2) = 5 calendar days.
        self.assertEqual(m.shipping_days, 5)
        self.assertEqual(m.shipping_business_days, 3)
        self.assertTrue(m.business_day_conversion_applied)

    def test_next_day(self):
        m = parse_policy_semantics("Next-day delivery available nationwide.")
        self.assertEqual(m.shipping_days, 1)
        self.assertFalse(m.ambiguous_shipping)

    def test_overnight(self):
        m = parse_policy_semantics("Overnight shipping on all orders.")
        self.assertEqual(m.shipping_days, 1)

    def test_ships_overnight_verb_form(self):
        m = parse_policy_semantics("Everything ships overnight.")
        self.assertEqual(m.shipping_days, 1)

    def test_same_day(self):
        m = parse_policy_semantics("Same-day dispatch for orders before 2pm.")
        self.assertEqual(m.shipping_days, 0)
        self.assertFalse(m.ambiguous_shipping)

    def test_word_number_shipping(self):
        m = parse_policy_semantics("Orders arrive within five days.")
        self.assertEqual(m.shipping_days, 5)

    def test_unparseable_shipping_defaults_with_ambiguity_flag(self):
        m = parse_policy_semantics("30-day returns on everything.")
        self.assertEqual(m.shipping_days, DEFAULT_SHIPPING_DAYS)
        self.assertTrue(m.ambiguous_shipping)
        self.assertIsNone(m.shipping_evidence)

    def test_returns_sentence_never_parses_as_shipping(self):
        # "returns within 30 days" must not be read as a 30-day shipping SLA.
        m = parse_policy_semantics("Returns within 30 days. Ships in 2 days.")
        self.assertEqual(m.shipping_days, 2)
        self.assertEqual(m.return_window_days, 30)


class FreeShippingTests(unittest.TestCase):
    """Unconditional vs threshold-conditional free shipping."""

    def test_unconditional(self):
        m = parse_policy_semantics("Free shipping on all orders.")
        self.assertTrue(m.free_shipping)
        self.assertFalse(m.free_shipping_conditional)
        self.assertIsNone(m.free_shipping_threshold)

    def test_conditional_threshold_captured(self):
        m = parse_policy_semantics("Free shipping on orders over $50.")
        self.assertTrue(m.free_shipping)
        self.assertTrue(m.free_shipping_conditional)
        self.assertEqual(m.free_shipping_threshold, 50.0)
        self.assertIn("$50", m.free_shipping_evidence)

    def test_conditional_reversed_phrasing(self):
        m = parse_policy_semantics("Orders over $75 ship free.")
        self.assertTrue(m.free_shipping_conditional)
        self.assertEqual(m.free_shipping_threshold, 75.0)

    def test_unconditional_wins_over_conditional_when_both_present(self):
        m = parse_policy_semantics(
            "Free shipping on all orders. Free express shipping on orders over $99."
        )
        self.assertTrue(m.free_shipping)
        self.assertFalse(m.free_shipping_conditional)

    def test_absent(self):
        m = parse_policy_semantics("Shipping is calculated at checkout.")
        self.assertFalse(m.free_shipping)

    def test_free_return_shipping_is_not_free_shipping(self):
        m = parse_policy_semantics("We offer free return shipping.")
        self.assertFalse(m.free_shipping)


class HiddenPenaltyTests(unittest.TestCase):
    """Each hidden-penalty term is captured with evidence text."""

    def _codes(self, metrics: PolicyMetrics):
        return {t.code: t for t in metrics.hidden_penalties}

    def test_restocking_fee_percent(self):
        m = parse_policy_semantics("We charge a 15% restocking fee.")
        terms = self._codes(m)
        self.assertIn("restocking_fee", terms)
        self.assertEqual(terms["restocking_fee"].percent, 15.0)
        self.assertIsNone(terms["restocking_fee"].amount)
        self.assertIn("restocking fee", terms["restocking_fee"].evidence.lower())

    def test_restocking_fee_dollar(self):
        m = parse_policy_semantics("A $10 restocking fee applies.")
        terms = self._codes(m)
        self.assertEqual(terms["restocking_fee"].amount, 10.0)
        self.assertIsNone(terms["restocking_fee"].percent)

    def test_restocking_fee_amount_after(self):
        m = parse_policy_semantics("Subject to a restocking fee of 20%.")
        terms = self._codes(m)
        self.assertEqual(terms["restocking_fee"].percent, 20.0)

    def test_restocking_fee_no_amount(self):
        m = parse_policy_semantics("A restocking fee may apply.")
        terms = self._codes(m)
        self.assertIn("restocking_fee", terms)
        self.assertIsNone(terms["restocking_fee"].percent)
        self.assertIsNone(terms["restocking_fee"].amount)

    def test_store_credit_only(self):
        m = parse_policy_semantics("Returns accepted for store credit only.")
        self.assertIn("store_credit_only", self._codes(m))

    def test_refunds_issued_as_store_credit(self):
        m = parse_policy_semantics("Refunds are issued as store credit.")
        self.assertIn("store_credit_only", self._codes(m))

    def test_exchange_only(self):
        m = parse_policy_semantics("Exchanges only, no cash refunds.")
        self.assertIn("exchange_only", self._codes(m))

    def test_customer_pays_return_shipping(self):
        m = parse_policy_semantics("Customer pays return shipping.")
        self.assertIn("customer_pays_return_shipping", self._codes(m))

    def test_return_shipping_customers_responsibility(self):
        m = parse_policy_semantics(
            "Return shipping is the customer's responsibility."
        )
        self.assertIn("customer_pays_return_shipping", self._codes(m))

    def test_final_sale_category(self):
        m = parse_policy_semantics("Clearance items are final sale.")
        terms = self._codes(m)
        self.assertIn("final_sale_category", terms)
        self.assertIn("clearance", terms["final_sale_category"].evidence.lower())

    def test_warranty_void(self):
        m = parse_policy_semantics("Warranty void if the seal is broken.")
        self.assertIn("warranty_void", self._codes(m))

    def test_voids_your_warranty_phrasing(self):
        m = parse_policy_semantics("Opening the enclosure voids your warranty.")
        self.assertIn("warranty_void", self._codes(m))

    def test_repeated_mentions_do_not_stack(self):
        m = parse_policy_semantics(
            "A 15% restocking fee applies. Note: the restocking fee is 15%."
        )
        codes = [t.code for t in m.hidden_penalties]
        self.assertEqual(codes.count("restocking_fee"), 1)

    def test_all_terms_together(self):
        m = parse_policy_semantics(
            "20% restocking fee. Store credit only. Exchanges only. "
            "Customer pays return shipping. Clearance items are final sale. "
            "Modification voids the warranty."
        )
        codes = {t.code for t in m.hidden_penalties}
        self.assertEqual(
            codes,
            {
                "restocking_fee",
                "store_credit_only",
                "exchange_only",
                "customer_pays_return_shipping",
                "final_sale_category",
                "warranty_void",
            },
        )
        for term in m.hidden_penalties:
            self.assertTrue(term.evidence)  # every term carries evidence


class NeverRaiseTests(unittest.TestCase):
    """parse_policy_semantics must never raise, whatever the input."""

    def test_empty_string(self):
        m = parse_policy_semantics("")
        self.assertTrue(m.returns_unspecified)
        self.assertTrue(m.ambiguous_shipping)
        self.assertEqual(m.shipping_days, DEFAULT_SHIPPING_DAYS)
        self.assertEqual(m.source_length, 0)

    def test_whitespace_only(self):
        m = parse_policy_semantics("   \n\t  ")
        self.assertTrue(m.returns_unspecified)

    def test_none_input(self):
        m = parse_policy_semantics(None)
        self.assertIsInstance(m, PolicyMetrics)
        self.assertTrue(m.ambiguous_shipping)

    def test_bytes_input(self):
        m = parse_policy_semantics(b"30-day returns \xff\xfe")
        self.assertIsInstance(m, PolicyMetrics)
        self.assertEqual(m.return_window_days, 30)

    def test_non_string_object(self):
        m = parse_policy_semantics(12345)
        self.assertIsInstance(m, PolicyMetrics)

    def test_emoji(self):
        m = parse_policy_semantics("🎉🚚📦 best shop ever 🎉")
        self.assertIsInstance(m, PolicyMetrics)
        self.assertTrue(m.ambiguous_shipping)

    def test_html_fragment_still_parses_content(self):
        m = parse_policy_semantics(
            "<div class='policy'><p>30-day returns</p><p>Ships in 2 days</p></div>"
        )
        self.assertEqual(m.return_window_days, 30)
        self.assertEqual(m.shipping_days, 2)

    def test_unicode_dash_range(self):
        # En-dash range must parse like an ASCII hyphen range.
        m = parse_policy_semantics("Ships in 4–6 business days.")
        self.assertEqual(m.shipping_days, 9)

    def test_huge_junk_input_is_bounded_and_safe(self):
        m = parse_policy_semantics("<" * 500_000)
        self.assertIsInstance(m, PolicyMetrics)

    def test_long_repetitive_text(self):
        m = parse_policy_semantics("lorem ipsum dolor " * 5_000)
        self.assertIsInstance(m, PolicyMetrics)


if __name__ == "__main__":
    unittest.main()


class TestReviewRegressionFixes(unittest.TestCase):
    """Adversarially-verified review findings pinned as regressions."""

    def test_threshold_free_shipping_is_conditional(self):
        for text in (
            "Free shipping when you spend $50.",
            "Free shipping on orders $75+.",
            "Free shipping with a minimum purchase of $60.",
        ):
            m = parse_policy_semantics(text)
            self.assertTrue(m.free_shipping, text)
            self.assertTrue(m.free_shipping_conditional, text)
            self.assertIsNotNone(m.free_shipping_threshold, text)

    def test_unconditional_free_shipping_still_wins(self):
        m = parse_policy_semantics("Free shipping on all orders.")
        self.assertTrue(m.free_shipping)
        self.assertFalse(m.free_shipping_conditional)

    def test_offering_store_credit_as_option_is_not_penalized(self):
        m = parse_policy_semantics(
            "Returns accepted; you may choose a refund or opt for store credit."
        )
        self.assertNotIn("store_credit_only", [p.code for p in m.hidden_penalties])
        m = parse_policy_semantics("All returns are for store credit only.")
        self.assertIn("store_credit_only", [p.code for p in m.hidden_penalties])

    def test_negated_restocking_fee_is_a_promise_not_a_penalty(self):
        for text in (
            "No restocking fees.",
            "We never charge restocking fees.",
            "Returns without any restocking fee.",
        ):
            m = parse_policy_semantics(text)
            self.assertNotIn("restocking_fee", [p.code for p in m.hidden_penalties], text)
        m = parse_policy_semantics("We charge a 15% restocking fee.")
        self.assertIn("restocking_fee", [p.code for p in m.hidden_penalties])

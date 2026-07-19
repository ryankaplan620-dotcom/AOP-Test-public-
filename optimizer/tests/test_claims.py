"""Tests for the Structured Claim Injector (aop_optimizer.claims)."""

import unittest

from aop_optimizer.claims import CLAIM_WEIGHTS, audit_product_claims, build_claims_payload

RICH_PRODUCT = {
    "title": "Red Thread Sweater",
    "sku": "RT-SWTR-RD",
    "description": (
        "GOTS certified organic cotton, made in Portugal. Comes with a "
        "5-year warranty. Weighs about 0.4 kg."
    ),
    "dimensions": {"width": 55, "height": 70, "unit": "cm"},
    "material": "100% organic cotton",
    "gtin": "0012345678905",
}

SPARSE_PRODUCT = {"title": "Mystery Widget", "description": "It is great and built to last."}


class TestAudit(unittest.TestCase):
    def test_rich_product_scores_full_marks(self):
        payload = build_claims_payload(RICH_PRODUCT)
        self.assertEqual(payload["claims_score"], 100)
        self.assertEqual(payload["injection_directives"], [])
        statuses = {a["claim"]: a["status"] for a in payload["audit"]}
        self.assertTrue(all(s == "present" for s in statuses.values()), statuses)

    def test_sparse_product_scores_zero_with_full_directive_list(self):
        payload = build_claims_payload(SPARSE_PRODUCT)
        self.assertEqual(payload["claims_score"], 0)
        self.assertEqual(len(payload["injection_directives"]), len(CLAIM_WEIGHTS))
        # Directives ranked by weight, heaviest first.
        weights = [d["weight"] for d in payload["injection_directives"]]
        self.assertEqual(weights, sorted(weights, reverse=True))

    def test_weights_sum_to_100(self):
        self.assertEqual(sum(CLAIM_WEIGHTS.values()), 100)

    def test_certifications_from_prose_and_explicit_field(self):
        prose = audit_product_claims({"description": "certified fair trade and OEKO-TEX tested"})
        certs = next(a for a in prose if a["claim"] == "CERTIFICATIONS")
        self.assertEqual(certs["status"], "present")
        self.assertIn("Fair Trade Certified", certs["detected"])
        self.assertIn("OEKO-TEX Standard 100", certs["detected"])

        explicit = audit_product_claims({"certifications": ["GOTS"]})
        self.assertEqual(next(a for a in explicit if a["claim"] == "CERTIFICATIONS")["status"], "present")

        fake = audit_product_claims({"description": "certified awesome by our founder"})
        self.assertEqual(next(a for a in fake if a["claim"] == "CERTIFICATIONS")["status"], "missing")

    def test_dimension_precision_needs_two_measurements(self):
        one = audit_product_claims({"description": "about 42 cm tall"})
        self.assertEqual(next(a for a in one if a["claim"] == "PRECISE_DIMENSIONS")["status"], "missing")
        two = audit_product_claims({"description": "42 cm tall and 30 cm wide"})
        self.assertEqual(next(a for a in two if a["claim"] == "PRECISE_DIMENSIONS")["status"], "present")

    def test_gtin_format_check(self):
        good = audit_product_claims({"barcode": "0012345678905"})
        self.assertEqual(next(a for a in good if a["claim"] == "IDENTIFIER_GTIN")["detected"], "0012345678905")
        bad = audit_product_claims({"barcode": "12345"})
        self.assertEqual(next(a for a in bad if a["claim"] == "IDENTIFIER_GTIN")["status"], "missing")

    def test_warranty_parsed_from_prose_in_months(self):
        audit = audit_product_claims({"description": "includes a 2-year warranty"})
        durability = next(a for a in audit if a["claim"] == "DURABILITY")
        self.assertEqual(durability["detected"], {"kind": "warranty_months", "value": 24.0})

    def test_hostile_input_never_raises(self):
        for hostile in (None, 42, "text", [], {"description": 9}, {"dimensions": "wat"}):
            payload = build_claims_payload(hostile)
            self.assertIn("claims_score", payload)


class TestJsonLd(unittest.TestCase):
    def test_present_claims_are_injected_as_schema_org(self):
        jsonld = build_claims_payload(RICH_PRODUCT)["product_jsonld"]
        self.assertEqual(jsonld["@type"], "Product")
        self.assertEqual(jsonld["sku"], "RT-SWTR-RD")
        self.assertEqual(jsonld["width"]["value"], 55.0)
        self.assertEqual(jsonld["height"]["unitText"], "cm")
        self.assertEqual(jsonld["material"], "100% organic cotton")
        self.assertEqual(jsonld["gtin"], "0012345678905")
        self.assertEqual(jsonld["countryOfOrigin"], "Portugal")
        cert_names = [c["name"] for c in jsonld["certification"]]
        self.assertIn("GOTS (Global Organic Textile Standard)", cert_names)
        self.assertEqual(jsonld["hasWarrantyPromise"]["durationOfWarranty"]["value"], 60.0)

    def test_missing_claims_are_never_fabricated(self):
        jsonld = build_claims_payload(SPARSE_PRODUCT)["product_jsonld"]
        for key in ("width", "weight", "material", "certification", "gtin", "countryOfOrigin", "hasWarrantyPromise"):
            self.assertNotIn(key, jsonld, f"{key} must not be invented")


if __name__ == "__main__":
    unittest.main()

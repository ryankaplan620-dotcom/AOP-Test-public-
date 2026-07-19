"""claims.py — the Structured Claim Injector (Agent SEO, spec feature C).

Role in the AOP data flow:
    [merchant product data] -> audit_product_claims() (which agent-favored
    signals are present / imprecise / missing) -> build_claims_payload()
    -> schema.org Product JSON-LD with every detected claim injected as
    structured data + directives for the gaps -> the dashboard's Data
    Optimizer panel / the merchant's product feed.

Why this exists (product spec, "Structured Claim Injectors"): LLM shopping
agents rank certainty. A product whose sustainability certification lives
only in prose ("our cotton is GOTS certified!") or whose dimensions are
vague ("fits most desks") is scored conservatively; the same facts emitted
as schema.org structured data are machine-verifiable signals the agent can
compare across merchants. This module (1) AUDITS a raw product record for
the claim classes agents weight, and (2) INJECTS everything it can verify
into a Product JSON-LD block, listing exactly what is still missing.

Honesty contract (same as the policy rewriter): the injector only emits
claims it actually found in the merchant's own product data — it structures
existing facts, it never invents them. Missing claims become directives
("add precise dimensions"), not fabricated properties; an agent that catches
a merchant lying never returns (and fabricated inventory/claims can be wire
fraud — compliance memo).

Stdlib only. Pure: no I/O; never raises on arbitrary input.
"""

import re
from typing import Any, Dict, List, Optional, Tuple

#: Recognized third-party certifications (lowercased match -> canonical name).
#: Deliberately a curated allowlist: "certified awesome" is not a signal.
CERTIFICATIONS = {
    "gots": "GOTS (Global Organic Textile Standard)",
    "oeko-tex": "OEKO-TEX Standard 100",
    "oeko tex": "OEKO-TEX Standard 100",
    "fair trade": "Fair Trade Certified",
    "fairtrade": "Fair Trade Certified",
    "fsc": "FSC (Forest Stewardship Council)",
    "energy star": "ENERGY STAR",
    "b corp": "Certified B Corporation",
    "b-corp": "Certified B Corporation",
    "bluesign": "bluesign",
    "cradle to cradle": "Cradle to Cradle Certified",
    "usda organic": "USDA Organic",
    "grs": "GRS (Global Recycled Standard)",
    "leather working group": "Leather Working Group",
    "rws": "RWS (Responsible Wool Standard)",
}

#: Dimension/weight units the precision detector accepts.
_LENGTH_UNITS = r"(?:mm|cm|m|in(?:ch(?:es)?)?|\"|ft|feet)"
_WEIGHT_UNITS = r"(?:mg|g|kg|oz|lbs?|pounds?|grams?|kilograms?|ounces?)"

#: value + unit, e.g. "42 cm", '17.5"', "1.2 kg".
_DIMENSION_RE = re.compile(rf"(\d+(?:\.\d+)?)\s*({_LENGTH_UNITS})\b", re.IGNORECASE)
_WEIGHT_RE = re.compile(rf"(\d+(?:\.\d+)?)\s*({_WEIGHT_UNITS})\b", re.IGNORECASE)

#: Durability signals: an explicit warranty period or a structured score.
_WARRANTY_RE = re.compile(r"(\d+)\s*[- ]?(year|yr|month)s?\s*(?:limited\s*)?warranty", re.IGNORECASE)

#: GTIN check-digit lengths (GTIN-8/12/13/14). Format check only — the edge
#: of what can be validated offline; registry verification is out of scope.
_GTIN_LENGTHS = {8, 12, 13, 14}

#: Claim classes with the weight agents (per our scoring model) place on
#: each; weights sum to 100 so the claims score reads as a percentage.
CLAIM_WEIGHTS = {
    "PRECISE_DIMENSIONS": 20,
    "WEIGHT": 10,
    "MATERIALS": 15,
    "CERTIFICATIONS": 20,
    "DURABILITY": 15,
    "IDENTIFIER_GTIN": 10,
    "COUNTRY_OF_ORIGIN": 10,
}


def _get(product: Any, *keys: str) -> Any:
    """First present key from a dict-ish product record; None otherwise."""
    if not isinstance(product, dict):
        return None
    for key in keys:
        try:
            value = product.get(key)
        except Exception:
            return None
        if value is not None and value != "":
            return value
    return None


def _text_blob(product: Any) -> str:
    """All free text worth scanning, bounded (hostile inputs stay cheap)."""
    parts: List[str] = []
    for key in ("title", "name", "description", "body_html", "details", "features"):
        value = _get(product, key)
        if isinstance(value, str):
            parts.append(value)
        elif isinstance(value, list):
            parts.extend(str(v) for v in value[:25] if isinstance(v, (str, int, float)))
    return " ".join(parts)[:20_000]


def _find_certifications(product: Any) -> List[str]:
    """Certifications from an explicit field first, then prose mentions."""
    found: List[str] = []
    explicit = _get(product, "certifications", "certification")
    entries = explicit if isinstance(explicit, list) else ([explicit] if isinstance(explicit, str) else [])
    haystacks = [str(e) for e in entries[:25]] + [_text_blob(product)]
    lowered = " | ".join(haystacks).lower()
    for needle, canonical in CERTIFICATIONS.items():
        if needle in lowered and canonical not in found:
            found.append(canonical)
    return found


def _find_dimensions(product: Any) -> Tuple[List[Dict[str, Any]], bool]:
    """(structured dimensions, precise?) from fields or prose.

    Precise = at least two distinct numeric measurements with units (a lone
    "42 cm" in prose is a hint, not a spec agents can fit into a box).
    """
    dims: List[Dict[str, Any]] = []
    explicit = _get(product, "dimensions")
    if isinstance(explicit, dict):
        for name in ("width", "height", "depth", "length"):
            raw = explicit.get(name)
            if isinstance(raw, (int, float)) and raw > 0:
                unit = explicit.get("unit") if isinstance(explicit.get("unit"), str) else "cm"
                dims.append({"name": name, "value": float(raw), "unit": unit})
            elif isinstance(raw, str):
                match = _DIMENSION_RE.search(raw)
                if match:
                    dims.append({"name": name, "value": float(match.group(1)), "unit": match.group(2).lower()})
    if not dims:
        matches = _DIMENSION_RE.findall(_text_blob(product))
        for value, unit in matches[:6]:
            dims.append({"name": "measurement", "value": float(value), "unit": unit.lower()})
    return dims, len(dims) >= 2


def _find_weight(product: Any) -> Optional[Dict[str, Any]]:
    explicit = _get(product, "weight")
    unit = _get(product, "weight_unit") or "kg"
    if isinstance(explicit, (int, float)) and explicit > 0:
        return {"value": float(explicit), "unit": str(unit)}
    if isinstance(explicit, str):
        match = _WEIGHT_RE.search(explicit)
        if match:
            return {"value": float(match.group(1)), "unit": match.group(2).lower()}
    match = _WEIGHT_RE.search(_text_blob(product))
    if match:
        return {"value": float(match.group(1)), "unit": match.group(2).lower()}
    return None


def _find_materials(product: Any) -> Optional[str]:
    explicit = _get(product, "material", "materials", "fabric", "composition")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()[:200]
    if isinstance(explicit, list):
        names = [str(m).strip() for m in explicit[:10] if str(m).strip()]
        if names:
            return ", ".join(names)[:200]
    return None


def _find_durability(product: Any) -> Optional[Dict[str, Any]]:
    """Warranty period (months) or an explicit durability score."""
    score = _get(product, "durability_score")
    if isinstance(score, (int, float)) and 0 <= score <= 100:
        return {"kind": "durability_score", "value": float(score)}
    warranty = _get(product, "warranty", "warranty_months")
    if isinstance(warranty, (int, float)) and warranty > 0:
        return {"kind": "warranty_months", "value": float(warranty)}
    match = _WARRANTY_RE.search(str(warranty) if isinstance(warranty, str) else _text_blob(product))
    if match:
        months = int(match.group(1)) * (12 if match.group(2).lower().startswith("y") else 1)
        return {"kind": "warranty_months", "value": float(months)}
    return None


def _find_gtin(product: Any) -> Optional[str]:
    raw = _get(product, "gtin", "gtin13", "barcode", "upc", "ean")
    digits = re.sub(r"\D", "", str(raw)) if raw is not None else ""
    return digits if len(digits) in _GTIN_LENGTHS else None


def _find_origin(product: Any) -> Optional[str]:
    raw = _get(product, "country_of_origin", "origin_country", "made_in")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()[:100]
    match = re.search(r"made in ([A-Z][A-Za-z ]{1,40})", _text_blob(product))
    return match.group(1).strip() if match else None


def audit_product_claims(product: Any) -> List[Dict[str, Any]]:
    """Audit one product record for the agent-favored claim classes.

    @returns one entry per CLAIM_WEIGHTS class:
        {claim, weight, status: 'present'|'missing', detected: <value|None>}
    Never raises on arbitrary input.
    """
    try:
        dims, precise = _find_dimensions(product)
        weight = _find_weight(product)
        materials = _find_materials(product)
        certs = _find_certifications(product)
        durability = _find_durability(product)
        gtin = _find_gtin(product)
        origin = _find_origin(product)

        def entry(claim: str, present: bool, detected: Any) -> Dict[str, Any]:
            return {
                "claim": claim,
                "weight": CLAIM_WEIGHTS[claim],
                "status": "present" if present else "missing",
                "detected": detected if present else None,
            }

        return [
            entry("PRECISE_DIMENSIONS", precise, dims),
            entry("WEIGHT", weight is not None, weight),
            entry("MATERIALS", materials is not None, materials),
            entry("CERTIFICATIONS", len(certs) > 0, certs),
            entry("DURABILITY", durability is not None, durability),
            entry("IDENTIFIER_GTIN", gtin is not None, gtin),
            entry("COUNTRY_OF_ORIGIN", origin is not None, origin),
        ]
    except Exception:
        # Absolute backstop: a hostile record audits as all-missing.
        return [
            {"claim": claim, "weight": weight, "status": "missing", "detected": None}
            for claim, weight in CLAIM_WEIGHTS.items()
        ]


#: Actionable text per missing claim class.
_DIRECTIVES = {
    "PRECISE_DIMENSIONS": "Publish exact width/height/depth with units (e.g. dimensions: {width: 42, height: 30, unit: 'cm'}) — agents cannot fit a product they cannot measure.",
    "WEIGHT": "Publish the shipping weight with a unit — agents estimate shipping cost and feasibility from it.",
    "MATERIALS": "List the material composition explicitly (e.g. '100% organic cotton') — a comparable, filterable agent signal.",
    "CERTIFICATIONS": "Add verified third-party certifications (GOTS, OEKO-TEX, Fair Trade, FSC, ...) as a structured field — agents treat certified claims as trust signals; unverifiable prose is discounted.",
    "DURABILITY": "State a concrete warranty period or durability score — agents convert 'built to last' to nothing, but '5-year warranty' to a number.",
    "IDENTIFIER_GTIN": "Publish the GTIN/UPC/EAN — the identifier agents use to match your listing against the rest of the market.",
    "COUNTRY_OF_ORIGIN": "State the country of origin — required input for agents estimating duties, delivery, and buyer preferences.",
}


def build_claims_payload(product: Any) -> Dict[str, Any]:
    """Audit + inject: the full Structured Claim Injector artifact.

    @returns {
        claims_score: 0-100 (sum of present claim weights),
        audit: [...per-class entries...],
        product_jsonld: schema.org Product with every PRESENT claim injected,
        injection_directives: [{claim, weight, action}] for the gaps,
    }
    """
    audit = audit_product_claims(product)
    score = sum(item["weight"] for item in audit if item["status"] == "present")
    by_claim = {item["claim"]: item for item in audit}

    jsonld: Dict[str, Any] = {"@context": "https://schema.org", "@type": "Product"}
    name = _get(product, "title", "name")
    if isinstance(name, str) and name.strip():
        jsonld["name"] = name.strip()[:200]
    sku = _get(product, "sku")
    if isinstance(sku, (str, int)):
        jsonld["sku"] = str(sku)[:100]

    dims_entry = by_claim["PRECISE_DIMENSIONS"]
    if dims_entry["status"] == "present":
        for dim in dims_entry["detected"]:
            key = {"width": "width", "height": "height", "depth": "depth", "length": "depth"}.get(dim["name"])
            quantity = {"@type": "QuantitativeValue", "value": dim["value"], "unitText": dim["unit"]}
            if key:
                jsonld[key] = quantity
            else:
                jsonld.setdefault("additionalProperty", []).append(
                    {"@type": "PropertyValue", "name": "measurement", "value": dim["value"], "unitText": dim["unit"]}
                )

    if by_claim["WEIGHT"]["status"] == "present":
        weight = by_claim["WEIGHT"]["detected"]
        jsonld["weight"] = {"@type": "QuantitativeValue", "value": weight["value"], "unitText": weight["unit"]}

    if by_claim["MATERIALS"]["status"] == "present":
        jsonld["material"] = by_claim["MATERIALS"]["detected"]

    if by_claim["CERTIFICATIONS"]["status"] == "present":
        jsonld["certification"] = [
            {"@type": "Certification", "name": cert} for cert in by_claim["CERTIFICATIONS"]["detected"]
        ]

    if by_claim["DURABILITY"]["status"] == "present":
        durability = by_claim["DURABILITY"]["detected"]
        if durability["kind"] == "warranty_months":
            jsonld["hasWarrantyPromise"] = {
                "@type": "WarrantyPromise",
                "durationOfWarranty": {
                    "@type": "QuantitativeValue",
                    "value": durability["value"],
                    "unitText": "months",
                },
            }
        else:
            jsonld.setdefault("additionalProperty", []).append(
                {"@type": "PropertyValue", "name": "durability_score", "value": durability["value"], "maxValue": 100}
            )

    if by_claim["IDENTIFIER_GTIN"]["status"] == "present":
        jsonld["gtin"] = by_claim["IDENTIFIER_GTIN"]["detected"]

    if by_claim["COUNTRY_OF_ORIGIN"]["status"] == "present":
        jsonld["countryOfOrigin"] = by_claim["COUNTRY_OF_ORIGIN"]["detected"]

    directives = [
        {"claim": item["claim"], "weight": item["weight"], "action": _DIRECTIVES[item["claim"]]}
        for item in audit
        if item["status"] == "missing"
    ]
    directives.sort(key=lambda d: d["weight"], reverse=True)

    return {
        "claims_score": score,
        "audit": audit,
        "product_jsonld": jsonld,
        "injection_directives": directives,
    }

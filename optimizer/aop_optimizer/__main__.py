"""
AOP :: optimizer/aop_optimizer/__main__.py
==========================================

Role in the AOP data flow
-------------------------
Command-line entry point for the policy scoring engine.  Used by merchant
onboarding tooling and by AOP operators to spot-check a policy page before
(or after) it is wired into the automated loss-diagnostics pipeline.  Reads
raw policy text, runs the full parse -> score -> directives pipeline, and
prints the schema_version 1.0.0 JSON payload to stdout.

Usage
-----
    python3 -m aop_optimizer [--file PATH] [--pretty]
                             [--baseline N] [--temperature N]

    --file PATH      read policy text from PATH (default: read stdin)
    --pretty         indent the JSON output for humans
    --baseline N     market_baseline_score for the logistic selection
                     probability (default 62)
    --temperature N  probability_temperature, must be > 0 (default 12)

Exit codes
----------
    0  success — payload printed to stdout
    2  usage error (empty input, unreadable file, bad flag values);
       explanation on stderr
    1  unexpected internal failure (should not happen — the pipeline is
       non-raising by contract; this is a last-resort guard)

Examples
--------
    echo "30-day returns. 2-day shipping." | python3 -m aop_optimizer --pretty
    python3 -m aop_optimizer --file policy.txt --baseline 55 --temperature 8
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import List, Optional

from .directives import build_directive_payload
from .scoring import AgentOptimizationEngine
from .semantics import parse_policy_semantics

#: Exit codes (documented above) — named so tests read clearly.
EXIT_OK = 0
EXIT_INTERNAL_ERROR = 1
EXIT_USAGE = 2


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="aop_optimizer",
        description=(
            "AOP policy scoring engine: parse merchant policy text, compute "
            "the Agent Match Score + Selection Probability, and emit "
            "machine-actionable optimization directives as JSON."
        ),
        epilog=(
            'Example: echo "30-day returns. 2-day shipping." | '
            "python3 -m aop_optimizer --pretty"
        ),
    )
    parser.add_argument(
        "--file",
        metavar="PATH",
        help="read policy text from PATH instead of stdin",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="pretty-print the JSON payload",
    )
    parser.add_argument(
        "--baseline",
        type=float,
        default=62.0,
        metavar="N",
        help="market baseline score for the selection probability (default 62)",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=12.0,
        metavar="N",
        help="logistic temperature, must be > 0 (default 12)",
    )
    return parser


def _read_input(file_path: Optional[str]) -> Optional[str]:
    """Read policy text from --file or stdin; None (with stderr note) on error.

    stdin is resolved at call time (not import time) so tests can swap
    sys.stdin in-process.
    """
    if file_path is not None:
        try:
            # errors="replace": a policy file with stray bytes should still
            # be scored — the parser tolerates replacement characters.
            with open(file_path, "r", encoding="utf-8", errors="replace") as handle:
                return handle.read()
        except OSError as exc:
            print(f"aop_optimizer: error: cannot read {file_path!r}: {exc}", file=sys.stderr)
            return None

    stdin = sys.stdin
    try:
        interactive = bool(stdin.isatty())
    except Exception:
        interactive = False
    if interactive:
        # No --file and stdin is a terminal: nothing was piped in.  Failing
        # fast with usage beats hanging forever waiting for keyboard input.
        print(
            "aop_optimizer: error: no input — pipe policy text on stdin or pass --file PATH",
            file=sys.stderr,
        )
        return None
    try:
        return stdin.read()
    except Exception as exc:
        print(f"aop_optimizer: error: cannot read stdin: {exc}", file=sys.stderr)
        return None


def main(argv: Optional[List[str]] = None) -> int:
    """CLI entry point; returns an exit code (callable in-process by tests)."""
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.temperature is None or args.temperature <= 0:
        print(
            "aop_optimizer: error: --temperature must be > 0",
            file=sys.stderr,
        )
        return EXIT_USAGE

    text = _read_input(args.file)
    if text is None:
        return EXIT_USAGE
    if not text.strip():
        print(
            "aop_optimizer: error: empty policy text — nothing to score",
            file=sys.stderr,
        )
        return EXIT_USAGE

    try:
        metrics = parse_policy_semantics(text)
        engine = AgentOptimizationEngine(
            market_baseline_score=args.baseline,
            probability_temperature=args.temperature,
        )
        report = engine.evaluate(metrics)
        payload = build_directive_payload(metrics, report)
        print(json.dumps(payload, indent=2 if args.pretty else None))
        return EXIT_OK
    except Exception as exc:  # pragma: no cover - pipeline is non-raising
        # Last-resort guard: the pipeline is non-raising by contract, but a
        # CLI must still never die with a traceback in an operator's face.
        print(f"aop_optimizer: internal error: {exc}", file=sys.stderr)
        return EXIT_INTERNAL_ERROR


if __name__ == "__main__":  # pragma: no cover - exercised via subprocess only
    sys.exit(main())

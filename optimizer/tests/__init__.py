"""
AOP :: optimizer/tests/__init__.py
==================================

Marks the test directory as a package so `python3 -m unittest discover`
(run from /home/user/AOP/optimizer) finds every test module.  The suite
covers the three stages of the policy-scoring pipeline:

  * test_semantics.py   — regex/heuristic extraction (semantics.py)
  * test_scoring.py     — deduction weights + logistic probability (scoring.py)
  * test_directives.py  — payload schema, gain consistency, CLI smoke
                          (directives.py + __main__.py)

Stdlib unittest only — no third-party test dependencies.
"""

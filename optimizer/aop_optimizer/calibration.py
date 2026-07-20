"""calibration.py — outcome-calibrated selection curves (logistic MLE).

Role in the AOP data flow:
    [ingestion /analytics: won/lost sessions per merchant]
        -> operator pairs each merchant's policy score with its observed
           outcomes and POSTs them to the optimizer server's /calibrate
        -> fit_selection_curve() (THIS MODULE) fits the selection-probability
           curve's two parameters by maximum likelihood
        -> /score, /rewrite, /simulate report probabilities from the FITTED
           curve instead of the hand-tuned defaults, with provenance.

Model
-----
The engine's selection probability (scoring.py) is

    P(win | score s) = sigmoid((s - baseline) / temperature)
                     = sigmoid(w*s + c)     with w = 1/temperature > 0,
                                                 c = -baseline/temperature.

Given aggregated outcome samples [{score, wins, losses}, ...] (one entry per
merchant/policy-version; a single session is wins=1 XOR losses=1), this module
fits (w, c) by Newton-Raphson on the Bernoulli log-likelihood and maps back to
(baseline, temperature). The fit REFUSES to produce a curve it cannot defend:

    - fewer than MIN_SESSIONS total sessions, or fewer than MIN_CLASS
      sessions in either class  -> {'ok': False, 'reason': 'insufficient_data'}
    - a non-positive fitted slope (the data says higher scores lose MORE)
      -> 'non_positive_slope' — an inverted curve must never ship silently
    - perfect/quasi separation or parameters outside plausible bounds
      -> 'implausible_fit'
    - Newton failing to converge -> 'no_convergence'

With only ONE distinct score in the data the slope is unidentifiable; the fit
degrades to 'intercept_only' mode: the default temperature is kept and only
the baseline is anchored so the curve passes through the observed win rate at
that score. This is the common single-merchant bootstrap case and is honest —
it calibrates the level, not the shape.

Fabrication guard: everything reported (log losses, counts, parameters) is
computed from the caller's data; nothing is invented. When the fit is
rejected the caller keeps the clearly-labeled defaults.

Stdlib only (math, typing) like the rest of the package.
"""

from __future__ import annotations

import math
from typing import Any, Dict, Iterable, List, Tuple

#: Defaults mirrored from scoring.AgentOptimizationEngine — the curve the
#: fitted one is compared against (and the fallback when rejected).
DEFAULT_BASELINE = 62.0
DEFAULT_TEMPERATURE = 12.0

#: Refuse to fit below these totals: a curve from a handful of sessions is
#: noise wearing a suit.
MIN_SESSIONS = 30
MIN_CLASS = 5

#: Plausibility bounds for accepted fits. Temperature below 0.5 is a step
#: function (quasi-separation); above 100 the curve is flat (no signal).
#: Baseline may sit somewhat outside [0, 100] (an extrapolated crossover),
#: but far outside means the data never brackets 50% and the fit is guesswork.
TEMPERATURE_BOUNDS = (0.5, 100.0)
BASELINE_BOUNDS = (-50.0, 200.0)

_MAX_NEWTON_ITER = 200
_TOL = 1e-10
_RIDGE = 1e-9
_CLAMP = 1e-12


def _sigmoid(z: float) -> float:
    if z > 60.0:
        return 1.0
    if z < -60.0:
        return 0.0
    return 1.0 / (1.0 + math.exp(-z))


#: Scores are agent match scores — the engine emits [0, 100]. A modest
#: margin is tolerated (a foreign scorer might overshoot slightly), but a
#: score like 9999 or 1e15 is a data error, and a single such row saturates
#: the sigmoid so hard it can poison the whole fit — reject it up front.
SCORE_BOUNDS = (-100.0, 300.0)

#: Count sanity cap. Beyond this the int->float conversions inside the
#: likelihood overflow (and no real deployment has a quadrillion sessions).
MAX_COUNT = 10**12


def _validate_samples(samples: Any) -> Tuple[List[Tuple[float, int, int]], str]:
    """Coerce and validate input; returns (rows, error_reason)."""
    if not isinstance(samples, (list, tuple)):
        return [], "samples_not_a_list"
    rows: List[Tuple[float, int, int]] = []
    for item in samples:
        if not isinstance(item, dict):
            return [], "sample_not_an_object"
        score = item.get("score")
        wins = item.get("wins")
        losses = item.get("losses")
        if (
            isinstance(score, bool)
            or not isinstance(score, (int, float))
            or not math.isfinite(float(score))
            or not (SCORE_BOUNDS[0] <= float(score) <= SCORE_BOUNDS[1])
        ):
            return [], "invalid_score"
        if isinstance(wins, bool) or not isinstance(wins, int) or wins < 0 or wins > MAX_COUNT:
            return [], "invalid_wins"
        if isinstance(losses, bool) or not isinstance(losses, int) or losses < 0 or losses > MAX_COUNT:
            return [], "invalid_losses"
        if wins + losses == 0:
            continue  # zero-weight row: nothing observed, nothing to fit
        rows.append((float(score), wins, losses))
    return rows, ""


def _log_loss(rows: Iterable[Tuple[float, int, int]], baseline: float, temperature: float) -> float:
    """Mean per-session negative log-likelihood for a (baseline, T) curve."""
    total = 0.0
    n = 0
    for score, wins, losses in rows:
        p = _sigmoid((score - baseline) / temperature)
        p = min(max(p, _CLAMP), 1.0 - _CLAMP)
        total -= wins * math.log(p) + losses * math.log(1.0 - p)
        n += wins + losses
    return total / n if n else float("inf")


def fit_selection_curve(samples: Any) -> Dict[str, Any]:
    """Fit the selection curve from won/lost sessions.

    @param samples: list of {"score": number, "wins": int, "losses": int}.
    @return on success: {"ok": True, "mode": "full"|"intercept_only",
        "market_baseline_score", "probability_temperature", "n_sessions",
        "n_wins", "n_losses", "n_distinct_scores", "iterations",
        "log_loss", "default_log_loss"}; on rejection: {"ok": False,
        "reason": str, "n_sessions": int}. Never raises — validation plus a
        defensive catch (reason 'internal_error') enforce the contract the
        server relies on.
    """
    try:
        return _fit_selection_curve(samples)
    except Exception:  # noqa: BLE001 — the never-raises contract IS the point
        return {"ok": False, "reason": "internal_error", "n_sessions": 0}


def _fit_selection_curve(samples: Any) -> Dict[str, Any]:
    rows, error = _validate_samples(samples)
    if error:
        return {"ok": False, "reason": error, "n_sessions": 0}

    n_wins = sum(w for _, w, _ in rows)
    n_losses = sum(l for _, _, l in rows)
    n_sessions = n_wins + n_losses
    if n_sessions < MIN_SESSIONS or n_wins < MIN_CLASS or n_losses < MIN_CLASS:
        return {"ok": False, "reason": "insufficient_data", "n_sessions": n_sessions}

    distinct_scores = sorted({score for score, _, _ in rows})

    # ---- intercept-only anchor: slope unidentifiable at one score --------
    if len(distinct_scores) == 1:
        s = distinct_scores[0]
        win_rate = n_wins / n_sessions  # both classes present -> 0 < rate < 1
        # sigmoid((s - b)/T0) = rate  =>  b = s - T0 * logit(rate)
        baseline = s - DEFAULT_TEMPERATURE * math.log(win_rate / (1.0 - win_rate))
        if not (BASELINE_BOUNDS[0] <= baseline <= BASELINE_BOUNDS[1]):
            return {"ok": False, "reason": "implausible_fit", "n_sessions": n_sessions}
        return {
            "ok": True,
            "mode": "intercept_only",
            "market_baseline_score": round(baseline, 4),
            "probability_temperature": DEFAULT_TEMPERATURE,
            "n_sessions": n_sessions,
            "n_wins": n_wins,
            "n_losses": n_losses,
            "n_distinct_scores": 1,
            "iterations": 0,
            "log_loss": round(_log_loss(rows, baseline, DEFAULT_TEMPERATURE), 6),
            "default_log_loss": round(_log_loss(rows, DEFAULT_BASELINE, DEFAULT_TEMPERATURE), 6),
        }

    # ---- full 2-parameter Newton-Raphson with backtracking ---------------
    # The safeguard matters: a raw Newton step overshoots on steep data and
    # a fixed clamp just oscillates between two overshoot points forever.
    # Backtracking (halve the step until the total negative log-likelihood
    # improves) is the standard IRLS fix and converges monotonically.
    def total_nll(w_: float, c_: float) -> float:
        total = 0.0
        for score, wins, losses in rows:
            p = min(max(_sigmoid(w_ * score + c_), _CLAMP), 1.0 - _CLAMP)
            total -= wins * math.log(p) + losses * math.log(1.0 - p)
        return total

    w = 1.0 / DEFAULT_TEMPERATURE  # warm start at the default curve
    c = -DEFAULT_BASELINE / DEFAULT_TEMPERATURE
    nll = total_nll(w, c)
    iterations = 0
    converged = False
    for iterations in range(1, _MAX_NEWTON_ITER + 1):
        grad_w = grad_c = 0.0
        h_ww = h_wc = h_cc = 0.0
        for score, wins, losses in rows:
            n_i = wins + losses
            p = _sigmoid(w * score + c)
            resid = wins - n_i * p
            weight = n_i * p * (1.0 - p)
            grad_w += resid * score
            grad_c += resid
            h_ww += weight * score * score
            h_wc += weight * score
            h_cc += weight
        # Newton direction: solve (H + ridge*I) d = grad (H is the Fisher
        # information — positive semi-definite).
        h_ww += _RIDGE
        h_cc += _RIDGE
        det = h_ww * h_cc - h_wc * h_wc
        if not math.isfinite(det) or abs(det) < 1e-300:
            return {"ok": False, "reason": "implausible_fit", "n_sessions": n_sessions}
        d_w = (h_cc * grad_w - h_wc * grad_c) / det
        d_c = (h_ww * grad_c - h_wc * grad_w) / det
        if not (math.isfinite(d_w) and math.isfinite(d_c)):
            return {"ok": False, "reason": "implausible_fit", "n_sessions": n_sessions}

        step = 1.0
        accepted = False
        for _ in range(40):
            cand_w, cand_c = w + step * d_w, c + step * d_c
            cand_nll = total_nll(cand_w, cand_c)
            if math.isfinite(cand_nll) and cand_nll <= nll:
                accepted = True
                break
            step *= 0.5
        if not accepted:
            # No improving step along this direction. That is only the
            # optimum if the gradient actually vanished — the gradient check
            # below decides; a STALL (large gradient, unusable direction,
            # e.g. a saturated outlier row) must not masquerade as a fit.
            converged = True
            break
        moved_w, moved_c = step * d_w, step * d_c
        improvement = nll - cand_nll
        w, c, nll = cand_w, cand_c, cand_nll
        if (abs(moved_w) < _TOL and abs(moved_c) < _TOL) or improvement < 1e-12:
            converged = True
            break
    if not converged:
        return {"ok": False, "reason": "no_convergence", "n_sessions": n_sessions}

    # First-order optimality check: an accepted fit must sit at a (near-)
    # zero gradient. Without this, a backtracking stall at the warm start
    # would ship the UNFITTED defaults labeled as a successful MLE — the
    # exact dishonesty this module exists to refuse.
    grad_w = grad_c = 0.0
    for score, wins, losses in rows:
        n_i = wins + losses
        p = _sigmoid(w * score + c)
        grad_w += (wins - n_i * p) * score
        grad_c += (wins - n_i * p)
    score_scale = max(1.0, max(abs(s) for s, _, _ in rows))
    if abs(grad_c) / n_sessions > 1e-6 or abs(grad_w) / (n_sessions * score_scale) > 1e-6:
        return {"ok": False, "reason": "no_convergence", "n_sessions": n_sessions}

    if w <= 0.0:
        # Data says higher scores lose more often. Shipping an inverted
        # curve would be worse than no calibration at all.
        return {"ok": False, "reason": "non_positive_slope", "n_sessions": n_sessions}

    temperature = 1.0 / w
    baseline = -c / w
    if not (TEMPERATURE_BOUNDS[0] <= temperature <= TEMPERATURE_BOUNDS[1]):
        return {"ok": False, "reason": "implausible_fit", "n_sessions": n_sessions}
    if not (BASELINE_BOUNDS[0] <= baseline <= BASELINE_BOUNDS[1]):
        return {"ok": False, "reason": "implausible_fit", "n_sessions": n_sessions}

    return {
        "ok": True,
        "mode": "full",
        "market_baseline_score": round(baseline, 4),
        "probability_temperature": round(temperature, 4),
        "n_sessions": n_sessions,
        "n_wins": n_wins,
        "n_losses": n_losses,
        "n_distinct_scores": len(distinct_scores),
        "iterations": iterations,
        "log_loss": round(_log_loss(rows, baseline, temperature), 6),
        "default_log_loss": round(_log_loss(rows, DEFAULT_BASELINE, DEFAULT_TEMPERATURE), 6),
    }

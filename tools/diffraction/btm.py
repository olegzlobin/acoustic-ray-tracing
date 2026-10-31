"""Exact edge diffraction of a rigid thin half-plane (BTM, Svensson et al. 1999, nu = 1/2), frequency domain:
    p_d(k) = -(nu / 4pi) * Int beta(z) exp(-jk(m+l)) / (m l) dz,   free field = exp(-jkR) / R.
Edge along y (infinite), half-plane hangs down from the edge at (xe, ze) in the x-z plane.
"""
import numpy as np

C = 343.0
NU = 0.5
XE, ZE = 5.487, 2.066


def theta(p):
    return (np.arctan2(p[1] - ZE, p[0] - XE) + np.pi / 2) % (2 * np.pi)


def grid(Y=40.0):
    y = np.concatenate([[0.0], np.geomspace(1e-7, 2e-3, 400), np.arange(2e-3, Y, 1.2e-3)])
    w = np.ones_like(y)
    t = y > 0.7 * Y
    w[t] = 0.5 * (1 + np.cos(np.pi * (y[t] - 0.7 * Y) / (0.3 * Y)))
    return y, w


Y_GRID, W_GRID = grid()


def btm(s, l, k):
    """Diffracted pressure at l from unit source at s (both at the same y), for wavenumbers k (array)."""
    rs = np.hypot(s[0] - XE, s[1] - ZE)
    rr = np.hypot(l[0] - XE, l[1] - ZE)
    ts, tr = theta(s), theta(l)
    y = Y_GRID
    m = np.sqrt(rs**2 + y**2)
    ll = np.sqrt(rr**2 + y**2)
    ch = np.maximum((m * ll + y * y) / (rs * rr), 1.0)
    eta = np.arccosh(ch)
    beta = 0.0
    for phi in (np.pi + ts + tr, np.pi + ts - tr, np.pi - ts + tr, np.pi - ts - tr):
        beta = beta + np.sin(NU * phi) / (np.cosh(NU * eta) - np.cos(NU * phi))
    f = beta * W_GRID / (m * ll)
    d = m + ll
    out = np.empty(len(k), complex)
    for i in range(0, len(k), 16):
        kk = k[i : i + 16, None]
        g = f * np.exp(-1j * kk * d)
        out[i : i + 16] = np.trapezoid(g, y, axis=1)
    return -(NU / (4 * np.pi)) * 2 * out  # symmetric in y


def visible(s, l, lo=-np.inf):
    """Straight line s-l passes the edge plane x = XE above ZE (or below lo)."""
    t = (XE - s[0]) / (l[0] - s[0])
    zc = s[1] + t * (l[1] - s[1])
    return zc > ZE or zc < lo


def dist(a, b):
    return float(np.hypot(a[0] - b[0], a[1] - b[1]))

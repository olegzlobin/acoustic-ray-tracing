"""UTD (Kouyoumjian-Pathak) wedge diffraction for a point source, rigid faces, time convention exp(+jwt)
so that the free field is exp(-jkR)/R. Returns A = p_d * (r1 + r2) * exp(+jk(r1 + r2)).

phi_s, phi_l: angles of source / listener measured from face 0 inside the open (air) sector, in (0, n*pi);
n = open wedge angle / pi (thin screen 2, 270-degree corner 1.5). r1 = |S-E|, r2 = |E-L| (3D), sinb = sin of
the skew angle between the edge and S-E.
"""
import numpy as np


def fresnel_fg(x):
    """Abramowitz & Stegun 7.3.32/33 auxiliary functions (|error| < 2e-3)."""
    f = (1 + 0.926 * x) / (2 + 1.792 * x + 3.104 * x * x)
    g = 1 / (2 + 4.142 * x + 3.492 * x * x + 6.670 * x**3)
    return f, g


def F(X):
    """UTD transition function 2j sqrt(X) e^{jX} int_{sqrt X}^inf e^{-j t^2} dt = sqrt(2 pi X) (f + j g)."""
    x = np.sqrt(2 * X / np.pi)
    f, g = fresnel_fg(x)
    return np.sqrt(2 * np.pi * X) * (f + 1j * g)


def a_pm(beta, n, sign):
    N = np.round((beta + sign * np.pi) / (2 * np.pi * n))
    return 2 * np.cos((2 * n * np.pi * N - beta) / 2) ** 2


def term(beta, n, sign, kL):
    arg = (np.pi + sign * beta) / (2 * n)
    if abs(np.sin(arg)) < 1e-12:
        arg += 1e-9
    return (np.cos(arg) / np.sin(arg)) * F(kL * a_pm(beta, n, sign))


def utd_A(phi_s, phi_l, n, r1, r2, sinb, k):
    kk = np.atleast_1d(k)
    L = r1 * r2 * sinb**2 / (r1 + r2)
    out = []
    for kv in kk:
        bm, bp = phi_l - phi_s, phi_l + phi_s
        s = term(bm, n, +1, kv * L) + term(bm, n, -1, kv * L) + term(bp, n, +1, kv * L) + term(bp, n, -1, kv * L)
        D = -np.exp(-1j * np.pi / 4) / (2 * n * np.sqrt(2 * np.pi * kv) * sinb) * s
        # p_d = e^{-jk r1}/r1 * D * sqrt(r1 / (r2 (r1 + r2))) * e^{-jk r2}
        out.append(D * np.sqrt((r1 + r2) / (r1 * r2)))
    return np.array(out)
